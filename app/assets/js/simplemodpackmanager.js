const AdmZip = require('adm-zip')
const crypto = require('crypto')
const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const semver = require('semver')
const { pipeline } = require('stream/promises')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('./configmanager')
const LauncherConfig = require('./launcherconfig')

const logger = LoggerUtil.getLogger('SimpleModpack')

const MODPACK_MANIFEST_URL = LauncherConfig.MANIFEST_URL
const LOCAL_VERSION_FILE = 'version.json'
const MANAGED_ROOTS = new Set(['mods', 'config', 'resourcepacks'])
const MODRINTH_API = 'https://api.modrinth.com/v2'
const RECOMMENDED_FABRIC_LOADER_VERSION = '0.19.2'
const MIN_FABRIC_LOADER_VERSION = '0.18.0'
const SODIUM_VERSION_RANGE = '>=0.5.11 <0.6.0'
const RUNTIME_MODS = Object.freeze({
    sodium: {
        id: 'sodium',
        project: 'sodium',
        requiredRange: SODIUM_VERSION_RANGE,
        label: 'Sodium'
    },
    fabricApi: {
        id: 'fabric-api',
        project: 'fabric-api',
        requiredRange: null,
        label: 'Fabric API'
    }
})

// These values are used before the remote manifest is downloaded.
const LAUNCH_PROFILE = Object.freeze({
    id: 'khaeris-fabric-1.20.1',
    name: 'Khaeris Fabric 1.20.1',
    minecraftVersion: '1.20.1',
    loader: 'fabric',
    loaderVersion: RECOMMENDED_FABRIC_LOADER_VERSION,
    instanceDir: 'khaeris-fabric-1.20.1'
})

function cloneLaunchProfile(manifest = null) {
    return {
        ...LAUNCH_PROFILE,
        id: manifest?.modpackId || LAUNCH_PROFILE.id,
        minecraftVersion: manifest?.minecraftVersion || LAUNCH_PROFILE.minecraftVersion,
        loader: manifest?.loader || LAUNCH_PROFILE.loader,
        loaderVersion: manifest?.loaderVersion || LAUNCH_PROFILE.loaderVersion,
        instanceDir: manifest?.modpackId || LAUNCH_PROFILE.instanceDir
    }
}

function createInstanceFolders(instanceDir) {
    for(const root of MANAGED_ROOTS) {
        fs.ensureDirSync(path.join(instanceDir, root))
    }
}

function isPathInside(baseDir, targetPath) {
    const base = path.resolve(baseDir)
    const target = path.resolve(targetPath)
    const compareBase = process.platform === 'win32' ? base.toLowerCase() : base
    const compareTarget = process.platform === 'win32' ? target.toLowerCase() : target
    return compareTarget === compareBase || compareTarget.startsWith(compareBase + path.sep)
}

function normalizeManagedPath(filePath) {
    if(typeof filePath !== 'string') {
        throw new Error('Each manifest file must have a path.')
    }

    const relativePath = path.posix.normalize(filePath.trim().replace(/\\/g, '/').replace(/^\/+/, ''))
    const root = relativePath.split('/')[0]
    if(relativePath === '' || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../') || !MANAGED_ROOTS.has(root)) {
        throw new Error(`Invalid manifest file path: ${filePath}`)
    }
    return relativePath
}

function resolveManagedFile(instanceDir, relativePath) {
    const targetPath = path.resolve(instanceDir, ...relativePath.split('/'))
    if(!isPathInside(instanceDir, targetPath)) {
        throw new Error(`Refusing to write outside the Khaeris instance: ${relativePath}`)
    }
    return targetPath
}

function requireRemoteUrl(url, name) {
    try {
        const parsed = new URL(url)
        if(parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString()
        }
    } catch(_err) {
        // Throw the clearer error below.
    }
    throw new Error(`Invalid URL for ${name}. Only http and https are allowed.`)
}

function requireSha256(value, name) {
    if(typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.trim())) {
        throw new Error(`Missing or invalid sha256 for ${name}.`)
    }
    return value.trim().toLowerCase()
}

function normalizeSize(size, name) {
    const value = Number(size)
    if(!Number.isFinite(value) || value < 0) {
        throw new Error(`Missing or invalid size for ${name}.`)
    }
    return value
}

function normalizeLoader(loader) {
    if(loader === 'vanilla' || loader === 'fabric' || loader === 'forge') {
        return loader
    }
    throw new Error(`Unsupported launcher loader: ${loader}`)
}

function coerceVersion(version) {
    const matches = String(version || '').match(/\d+\.\d+\.\d+/g)
    if(matches == null || matches.length === 0) {
        return null
    }
    const value = String(version || '')
    const selected = value.includes('-') ? matches[matches.length - 1] : matches[0]
    return semver.coerce(selected)
}

function compareVersions(a, b) {
    const aVersion = coerceVersion(a)
    const bVersion = coerceVersion(b)
    if(aVersion == null && bVersion == null) {
        return 0
    }
    if(aVersion == null) {
        return -1
    }
    if(bVersion == null) {
        return 1
    }
    return semver.compare(aVersion, bVersion)
}

function maxVersion(...versions) {
    return versions
        .filter(version => version != null && String(version).trim() !== '')
        .map(version => String(version).trim())
        .sort((a, b) => compareVersions(b, a))[0] || null
}

function satisfiesRange(version, range) {
    const matches = String(version || '').match(/\d+\.\d+\.\d+/g)
    return (matches || []).some(match => semver.satisfies(semver.coerce(match), range, {
        includePrerelease: true
    }))
}

function normalizeFabricLoaderVersion(loaderVersion) {
    return maxVersion(loaderVersion, MIN_FABRIC_LOADER_VERSION, RECOMMENDED_FABRIC_LOADER_VERSION)
}

function normalizeManifest(rawManifest) {
    if(rawManifest == null || typeof rawManifest !== 'object') {
        throw new Error('manifest.json must contain a JSON object.')
    }
    if(typeof rawManifest.modpackId !== 'string' || rawManifest.modpackId.trim() === '') {
        throw new Error('manifest.json must contain modpackId.')
    }
    if(typeof rawManifest.version !== 'string' || rawManifest.version.trim() === '') {
        throw new Error('manifest.json must contain version.')
    }
    if(typeof rawManifest.minecraftVersion !== 'string' || rawManifest.minecraftVersion.trim() === '') {
        throw new Error('manifest.json must contain minecraftVersion.')
    }
    if(!Array.isArray(rawManifest.files)) {
        throw new Error('manifest.json files must be an array.')
    }

    const files = rawManifest.files.map(rawFile => {
        const relativePath = normalizeManagedPath(rawFile?.path)
        return {
            path: relativePath,
            url: requireRemoteUrl(rawFile?.url, relativePath),
            sha256: requireSha256(rawFile?.sha256, relativePath),
            size: normalizeSize(rawFile?.size, relativePath)
        }
    })
    const uniquePaths = new Set(files.map(file => file.path))
    if(uniquePaths.size !== files.length) {
        throw new Error('manifest.json has duplicate file paths.')
    }

    const loader = normalizeLoader(rawManifest.loader || 'vanilla')
    const loaderVersion = rawManifest.loaderVersion == null ? null : String(rawManifest.loaderVersion).trim()

    return {
        modpackId: rawManifest.modpackId.trim(),
        version: rawManifest.version.trim(),
        minecraftVersion: rawManifest.minecraftVersion.trim(),
        loader,
        loaderVersion: loader === 'fabric' ? normalizeFabricLoaderVersion(loaderVersion) : loaderVersion,
        baseZip: requireRemoteUrl(rawManifest.baseZip, 'baseZip'),
        baseZipSha256: rawManifest.baseZipSha256 == null ? null : requireSha256(rawManifest.baseZipSha256, 'baseZip'),
        baseZipSize: rawManifest.baseZipSize == null ? null : normalizeSize(rawManifest.baseZipSize, 'baseZip'),
        files
    }
}

function getVersionPath(instanceDir) {
    return path.join(instanceDir, LOCAL_VERSION_FILE)
}

async function readLocalVersion(instanceDir) {
    const versionPath = getVersionPath(instanceDir)
    if(!await fs.pathExists(versionPath)) {
        return null
    }

    try {
        const localVersion = await fs.readJson(versionPath)
        return {
            ...localVersion,
            files: Array.isArray(localVersion.files) ? localVersion.files : []
        }
    } catch(err) {
        logger.warn(`Unable to read ${versionPath}. A fresh base ZIP install will be used.`, err)
        return null
    }
}

async function hashFile(filePath) {
    return await hashFileWithAlgo(filePath, 'sha256')
}

async function hashFileWithAlgo(filePath, algo = 'sha256') {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash(algo)
        const input = fs.createReadStream(filePath)

        input.on('data', chunk => hash.update(chunk))
        input.on('error', reject)
        input.on('end', () => resolve(hash.digest('hex')))
    })
}

async function matchesExpectedFile(filePath, expected) {
    if(!await fs.pathExists(filePath)) {
        return false
    }

    const stat = await fs.stat(filePath)
    if(stat.size !== expected.size) {
        return false
    }
    return await hashFile(filePath) === expected.sha256
}

function emitDownloadProgress(onProgress, phase, file, transferred, total) {
    onProgress({
        phase,
        file,
        transferred,
        bytesTotal: total
    })
}

async function downloadToFile(url, targetPath, expected, onProgress, phase) {
    const tempPath = `${targetPath}.part`
    await fs.ensureDir(path.dirname(targetPath))
    await fs.remove(tempPath)

    try {
        console.log('[Modpack] Download:', url)
        const stream = got.stream(url, {
            retry: {
                limit: 0
            },
            timeout: {
                request: 30000
            }
        })
        stream.on('downloadProgress', progress => {
            emitDownloadProgress(onProgress, phase, expected.path || 'base.zip', progress.transferred, progress.total)
        })
        await pipeline(stream, fs.createWriteStream(tempPath))

        if(expected.size != null && (await fs.stat(tempPath)).size !== expected.size) {
            throw new Error(`Downloaded size does not match for ${expected.path || 'base.zip'}.`)
        }
        const expectedHash = expected.hash || expected.sha256
        const expectedAlgo = expected.hashAlgo || 'sha256'
        if(expectedHash != null && await hashFileWithAlgo(tempPath, expectedAlgo) !== expectedHash) {
            throw new Error(`${expectedAlgo.toUpperCase()} verification failed for ${expected.path || 'base.zip'}.`)
        }
        await fs.move(tempPath, targetPath, { overwrite: true })
    } catch(err) {
        await fs.remove(tempPath)
        console.error('[Modpack] Download failed:', {
            url,
            statusCode: err.response?.statusCode,
            statusMessage: err.response?.statusMessage,
            responseUrl: err.response?.url
        })
        throw err
    }
}

function normalizeZipEntry(entryName) {
    const relativePath = path.posix.normalize(entryName.replace(/\\/g, '/').replace(/^\/+/, ''))
    if(relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
        return null
    }
    return relativePath
}

function getManagedZipEntry(entryName) {
    const relativePath = normalizeZipEntry(entryName)
    if(relativePath == null) {
        return null
    }

    const parts = relativePath.split('/').filter(Boolean)
    if(parts[0] === 'overrides') {
        parts.shift()
    }
    const managedIndex = parts.findIndex(part => MANAGED_ROOTS.has(part))
    if(managedIndex === -1) {
        return null
    }
    return normalizeManagedPath(parts.slice(managedIndex).join('/'))
}

async function clearManagedRoots(instanceDir) {
    for(const root of MANAGED_ROOTS) {
        await fs.remove(path.join(instanceDir, root))
    }
    createInstanceFolders(instanceDir)
}

async function removeInstanceDirectory(instanceDir) {
    const instancesDir = ConfigManager.getInstanceDirectory()
    if(!isPathInside(instancesDir, instanceDir) || path.resolve(instancesDir) === path.resolve(instanceDir)) {
        throw new Error(`Refusing to repair unsafe instance path: ${instanceDir}`)
    }
    await fs.remove(instanceDir)
    createInstanceFolders(instanceDir)
}

async function extractBaseZip(zipPath, instanceDir, onProgress) {
    const zip = new AdmZip(zipPath)
    const entries = zip.getEntries().filter(entry => !entry.isDirectory)
    let extracted = 0

    await clearManagedRoots(instanceDir)
    for(const entry of entries) {
        const relativePath = getManagedZipEntry(entry.entryName)
        if(relativePath == null) {
            continue
        }

        const targetPath = resolveManagedFile(instanceDir, relativePath)
        await fs.ensureDir(path.dirname(targetPath))
        await fs.writeFile(targetPath, entry.getData())
        extracted++
        onProgress({
            phase: 'extract',
            file: relativePath,
            current: extracted,
            total: entries.length
        })
    }
}

function requiresBaseInstall(localVersion, manifest) {
    return localVersion == null
        || localVersion.modpackId !== manifest.modpackId
        || localVersion.minecraftVersion !== manifest.minecraftVersion
        || localVersion.loader !== manifest.loader
        || localVersion.loaderVersion !== manifest.loaderVersion
}

async function installBaseZip(instanceDir, manifest, onProgress) {
    logger.info(`Installing base.zip for ${manifest.modpackId} ${manifest.version}.`)
    const zipPath = path.join(instanceDir, '.khaeris-base.zip')
    try {
        await downloadToFile(manifest.baseZip, zipPath, {
            path: 'base.zip',
            sha256: manifest.baseZipSha256,
            size: manifest.baseZipSize
        }, onProgress, 'baseZip')
        await extractBaseZip(zipPath, instanceDir, onProgress)
    } finally {
        await fs.remove(zipPath)
    }
}

async function syncManifestFiles(instanceDir, manifest, onProgress) {
    const downloaded = []

    for(let i=0; i<manifest.files.length; i++) {
        const file = manifest.files[i]
        const targetPath = resolveManagedFile(instanceDir, file.path)
        onProgress({
            phase: 'fileCheck',
            file: file.path,
            current: i,
            total: manifest.files.length
        })

        if(!await matchesExpectedFile(targetPath, file)) {
            onProgress({
                phase: 'fileDownload',
                file: file.path,
                current: i,
                total: manifest.files.length
            })
            await downloadToFile(file.url, targetPath, file, onProgress, 'fileDownloadProgress')
            downloaded.push(file.path)
            logger.info(`Updated managed file: ${file.path}`)
        }
    }
    return downloaded
}

async function removeOldManagedFiles(instanceDir, localVersion, manifest, onProgress) {
    const previousFiles = Array.isArray(localVersion?.files) ? localVersion.files : []
    const nextPaths = new Set(manifest.files.map(file => file.path))
    const removed = []

    for(const previousFile of previousFiles) {
        if(typeof previousFile.path !== 'string' || nextPaths.has(previousFile.path)) {
            continue
        }
        const relativePath = normalizeManagedPath(previousFile.path)
        await fs.remove(resolveManagedFile(instanceDir, relativePath))
        removed.push(relativePath)
        logger.info(`Removed managed file no longer in manifest: ${relativePath}`)
        onProgress({
            phase: 'cleanup',
            file: relativePath,
            current: removed.length,
            total: previousFiles.length
        })
    }
    return removed
}

async function fetchManifest() {
    try {
        console.log('[Modpack] Download:', MODPACK_MANIFEST_URL)
        const response = await got.get(MODPACK_MANIFEST_URL, {
            responseType: 'json',
            retry: {
                limit: 0
            },
            timeout: {
                request: 10000
            }
        })
        const manifest = normalizeManifest(response.body)
        console.log('[Manifest Loaded]', manifest)
        return manifest
    } catch(err) {
        console.error('[Modpack] Manifest download failed:', {
            url: MODPACK_MANIFEST_URL,
            statusCode: err.response?.statusCode,
            statusMessage: err.response?.statusMessage,
            responseUrl: err.response?.url
        })
        throw err
    }
}

async function listJarFiles(dir) {
    if(!await fs.pathExists(dir)) {
        return []
    }

    const entries = await fs.readdir(dir, {
        withFileTypes: true
    })
    return entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
        .map(entry => path.join(dir, entry.name))
}

function readFabricModMetadata(jarPath) {
    try {
        const zip = new AdmZip(jarPath)
        const entry = zip.getEntry('fabric.mod.json')
        if(entry == null) {
            return null
        }
        const metadata = JSON.parse(entry.getData().toString('utf8'))
        if(typeof metadata.id !== 'string') {
            return null
        }
        return {
            id: metadata.id,
            version: String(metadata.version || ''),
            depends: metadata.depends || {},
            path: jarPath
        }
    } catch(err) {
        logger.warn(`Unable to read fabric.mod.json in ${jarPath}.`, err)
        return null
    }
}

async function readInstalledFabricMods(instanceDir) {
    const modsDir = path.join(instanceDir, 'mods')
    const mods = []
    for(const jarPath of await listJarFiles(modsDir)) {
        const metadata = readFabricModMetadata(jarPath)
        if(metadata != null) {
            mods.push(metadata)
        }
    }
    return mods
}

function dependencyValue(depends, ...keys) {
    for(const key of keys) {
        if(depends?.[key] != null) {
            return depends[key]
        }
    }
    return null
}

function minimumVersionFromDependency(value) {
    if(Array.isArray(value)) {
        return maxVersion(...value.map(minimumVersionFromDependency))
    }
    if(typeof value !== 'string' || value.trim() === '' || value === '*') {
        return null
    }

    try {
        const min = semver.minVersion(value)
        if(min != null) {
            return min.version
        }
    } catch(_err) {
        // Some mods use Fabric-style ranges which are not strict semver ranges.
    }

    const match = value.match(/(?:>=|>|=)?\s*(\d+\.\d+\.\d+)/)
    return match?.[1] || null
}

function getRequiredFabricLoaderVersion(mods) {
    const requiredVersions = [MIN_FABRIC_LOADER_VERSION]
    for(const mod of mods) {
        const dependency = dependencyValue(mod.depends, 'fabricloader', 'fabric-loader')
        const minimum = minimumVersionFromDependency(dependency)
        if(minimum != null) {
            requiredVersions.push(minimum)
        }
    }
    return maxVersion(...requiredVersions)
}

function findInstalledMod(mods, modId) {
    return mods.find(mod => mod.id === modId) || null
}

async function removeInstalledMod(instanceDir, modId) {
    const removed = []
    for(const mod of await readInstalledFabricMods(instanceDir)) {
        if(mod.id === modId) {
            await fs.remove(mod.path)
            removed.push(path.basename(mod.path))
        }
    }
    return removed
}

function primaryModrinthFile(version) {
    return version.files?.find(file => file.primary && file.url != null)
        || version.files?.find(file => file.url != null && String(file.filename || '').toLowerCase().endsWith('.jar'))
        || null
}

async function getModrinthVersion(project, minecraftVersion, versionFilter = () => true) {
    const response = await got.get(`${MODRINTH_API}/project/${project}/version`, {
        responseType: 'json',
        searchParams: {
            loaders: JSON.stringify(['fabric']),
            game_versions: JSON.stringify([minecraftVersion])
        },
        retry: {
            limit: 1
        },
        timeout: {
            request: 15000
        }
    })

    const versions = response.body
        .filter(version => version.version_type === 'release')
        .filter(version => versionFilter(version.version_number))
        .sort((a, b) => compareVersions(b.version_number, a.version_number))

    const version = versions[0]
    const file = version == null ? null : primaryModrinthFile(version)
    if(version == null || file == null) {
        throw new Error(`Impossible de trouver ${project} compatible avec Minecraft ${minecraftVersion}.`)
    }

    return {
        version,
        file
    }
}

function modrinthHash(file) {
    if(file.hashes?.sha512 != null) {
        return {
            hash: file.hashes.sha512,
            hashAlgo: 'sha512'
        }
    }
    if(file.hashes?.sha1 != null) {
        return {
            hash: file.hashes.sha1,
            hashAlgo: 'sha1'
        }
    }
    return {
        hash: null,
        hashAlgo: null
    }
}

async function installModrinthMod(instanceDir, runtimeMod, minecraftVersion, versionFilter, onProgress) {
    onProgress({
        phase: 'runtimeCheck',
        file: runtimeMod.label
    })
    const {
        version,
        file
    } = await getModrinthVersion(runtimeMod.project, minecraftVersion, versionFilter)
    const targetPath = path.join(instanceDir, 'mods', file.filename)
    const hash = modrinthHash(file)

    await removeInstalledMod(instanceDir, runtimeMod.id)
    logger.info(`Installing ${runtimeMod.label} ${version.version_number} from Modrinth.`)
    await downloadToFile(file.url, targetPath, {
        path: file.filename,
        size: file.size,
        ...hash
    }, onProgress, 'runtimeDownload')
    return version.version_number
}

async function ensureSodium(instanceDir, manifest, mods, onProgress) {
    const installed = findInstalledMod(mods, RUNTIME_MODS.sodium.id)
    if(installed != null && satisfiesRange(installed.version, RUNTIME_MODS.sodium.requiredRange)) {
        return installed.version
    }

    return await installModrinthMod(
        instanceDir,
        RUNTIME_MODS.sodium,
        manifest.minecraftVersion,
        versionNumber => satisfiesRange(versionNumber, RUNTIME_MODS.sodium.requiredRange),
        onProgress
    )
}

async function ensureFabricApi(instanceDir, manifest, mods, onProgress) {
    const installed = findInstalledMod(mods, RUNTIME_MODS.fabricApi.id)
    if(installed != null && installed.version.includes(`+${manifest.minecraftVersion}`)) {
        return installed.version
    }

    return await installModrinthMod(
        instanceDir,
        RUNTIME_MODS.fabricApi,
        manifest.minecraftVersion,
        () => true,
        onProgress
    )
}

function assertRuntimeCompatibility(manifest, mods) {
    const requiredLoader = getRequiredFabricLoaderVersion(mods)
    if(compareVersions(manifest.loaderVersion, requiredLoader) < 0) {
        throw new Error(`Modpack incompatible: Fabric Loader ${manifest.loaderVersion} est trop ancien. Version requise: ${requiredLoader} ou plus.`)
    }

    const sodium = findInstalledMod(mods, RUNTIME_MODS.sodium.id)
    if(sodium == null || !satisfiesRange(sodium.version, SODIUM_VERSION_RANGE)) {
        throw new Error(`Modpack incompatible: Sodium doit etre entre 0.5.11 et 0.6. Version detectee: ${sodium?.version || 'absente'}.`)
    }

    const fabricApi = findInstalledMod(mods, RUNTIME_MODS.fabricApi.id)
    if(fabricApi == null) {
        throw new Error('Modpack incompatible: Fabric API est absent.')
    }
}

async function ensureRuntimeCompatibility(instanceDir, manifest, onProgress) {
    if(manifest.loader === 'fabric' && process.env.KHAERIS_ALLOW_RUNTIME_DOWNLOADS === 'true') {
        onProgress({
            phase: 'runtimeCheck',
            file: 'Fabric runtime'
        })

        let mods = await readInstalledFabricMods(instanceDir)
        const requiredLoader = getRequiredFabricLoaderVersion(mods)
        manifest.loaderVersion = maxVersion(manifest.loaderVersion, requiredLoader, RECOMMENDED_FABRIC_LOADER_VERSION)

        const sodiumVersion = await ensureSodium(instanceDir, manifest, mods, onProgress)
        mods = await readInstalledFabricMods(instanceDir)
        const fabricApiVersion = await ensureFabricApi(instanceDir, manifest, mods, onProgress)
        mods = await readInstalledFabricMods(instanceDir)
        assertRuntimeCompatibility(manifest, mods)

        return {
            loaderVersion: manifest.loaderVersion,
            sodiumVersion,
            fabricApiVersion,
            source: 'modrinth'
        }
    }

    return {
        loaderVersion: manifest.loaderVersion,
        source: 'manifest'
    }
}

function getProfileIndex(profiles, profileId) {
    return profiles.findIndex(profile => profile.id === profileId)
}

exports.MODPACK_MANIFEST_URL = MODPACK_MANIFEST_URL
exports.RECOMMENDED_FABRIC_LOADER_VERSION = RECOMMENDED_FABRIC_LOADER_VERSION
exports.SODIUM_VERSION_RANGE = SODIUM_VERSION_RANGE

exports.getLaunchProfileTemplate = function() {
    return cloneLaunchProfile()
}

exports.isSimpleProfile = function(profile) {
    return profile?.id === LAUNCH_PROFILE.id || profile?.id === 'khaeris-rp'
}

exports.ensureLaunchProfile = async function(manifest = null) {
    const nextProfile = cloneLaunchProfile(manifest)
    const profiles = ConfigManager.getProfiles()
    const profileIndex = getProfileIndex(profiles, nextProfile.id)
    let profile

    if(profileIndex === -1) {
        profile = ConfigManager.createProfile(nextProfile)
    } else {
        profile = profiles[profileIndex]
        Object.assign(profile, nextProfile)
        ConfigManager.saveProfiles()
        createInstanceFolders(ConfigManager.getProfileInstanceDirectory(profile))
    }

    ConfigManager.ensureProfileJavaConfig(profile)
    return profile
}

exports.getBootstrapDistribution = function() {
    const profile = cloneLaunchProfile()
    return {
        version: 'simple-modpack',
        discord: null,
        java: null,
        rss: '',
        servers: [
            {
                id: profile.id,
                name: profile.name,
                description: 'Manifest web Khaeris',
                icon: '',
                version: 'manifest',
                address: 'localhost',
                minecraftVersion: profile.minecraftVersion,
                mainServer: true,
                autoconnect: false,
                javaOptions: ConfigManager.getProfileJavaOptions(profile),
                modules: []
            }
        ]
    }
}

exports.syncModpack = async function(onProgress = () => {}, options = {}) {
    logger.info(`Starting modpack sync from ${MODPACK_MANIFEST_URL}.`)
    onProgress({
        phase: 'manifest'
    })

    const manifest = await fetchManifest()
    const profile = await exports.ensureLaunchProfile(manifest)
    const instanceDir = ConfigManager.getProfileInstanceDirectory(profile)
    createInstanceFolders(instanceDir)

    const localVersion = await readLocalVersion(instanceDir)
    let usedBaseZip = false
    if(options.forceBaseInstall === true) {
        logger.info(`Force reinstall requested. Removing local instance at ${instanceDir}.`)
        onProgress({
            phase: 'repair'
        })
        await removeInstanceDirectory(instanceDir)
    }

    if(options.forceBaseInstall === true || requiresBaseInstall(localVersion, manifest)) {
        usedBaseZip = true
        await installBaseZip(instanceDir, manifest, onProgress)
    } else {
        logger.info(`Local version is compatible. Checking ${manifest.files.length} manifest file(s).`)
    }

    const downloaded = await syncManifestFiles(instanceDir, manifest, onProgress)
    const removed = await removeOldManagedFiles(instanceDir, localVersion, manifest, onProgress)
    const runtime = await ensureRuntimeCompatibility(instanceDir, manifest, onProgress)
    const runtimeProfile = await exports.ensureLaunchProfile(manifest)
    Object.assign(profile, runtimeProfile)
    await fs.writeJson(getVersionPath(instanceDir), {
        modpackId: manifest.modpackId,
        version: manifest.version,
        minecraftVersion: manifest.minecraftVersion,
        loader: manifest.loader,
        loaderVersion: manifest.loaderVersion,
        runtime,
        files: manifest.files,
        installedAt: new Date().toISOString()
    }, {
        spaces: 4
    })

    onProgress({
        phase: 'done',
        version: manifest.version,
        total: manifest.files.length
    })

    logger.info(`Modpack sync complete. baseZip=${usedBaseZip}, downloaded=${downloaded.length}, removed=${removed.length}.`)

    return {
        profile,
        instanceDir,
        manifest,
        runtime,
        usedBaseZip,
        downloaded,
        removed
    }
}

exports.fetchManifest = fetchManifest

exports.repairModpack = async function(onProgress = () => {}) {
    logger.info('Repair requested. Reinstalling Khaeris modpack from base.zip and manifest.')
    return await exports.syncModpack(onProgress, {
        forceBaseInstall: true
    })
}
