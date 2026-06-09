const fs = require('fs-extra')
const got = require('got')
const path = require('path')
const AdmZip = require('adm-zip')
const child_process = require('child_process')
const { pipeline } = require('stream/promises')
const { downloadQueue, getExpectedDownloadSize, MojangIndexProcessor } = require('helios-core/dl')
const { HeliosDistribution, MavenUtil, validateLocalFile } = require('helios-core/common')

const ConfigManager = require('./configmanager')

const FABRIC_META_ENDPOINT = 'https://meta.fabricmc.net/v2'
const FABRIC_MAVEN_ENDPOINT = 'https://maven.fabricmc.net/'
const FORGE_MAVEN_ENDPOINT = 'https://maven.minecraftforge.net/'
const FORGE_METADATA_ENDPOINT = `${FORGE_MAVEN_ENDPOINT}net/minecraftforge/forge/maven-metadata.xml`
const HASH_ALGO_MD5 = 'md5'
const HASH_ALGO_SHA1 = 'sha1'
const MIN_FABRIC_LOADER_VERSION = '0.18.0'
const RECOMMENDED_FABRIC_LOADER_VERSION = '0.19.2'

function normalizeRepoUrl(url) {
    return url.endsWith('/') ? url : `${url}/`
}

function isRemoteUrl(url) {
    return typeof url === 'string' && /^https?:\/\//.test(url)
}

function libraryPath(commonDir, name) {
    return path.join(commonDir, 'libraries', MavenUtil.mavenIdentifierAsPath(name))
}

function libraryUrl(lib) {
    return normalizeRepoUrl(lib.url || FABRIC_MAVEN_ENDPOINT) + MavenUtil.mavenIdentifierAsPath(lib.name).replace(/\\/g, '/')
}

function artifactPath(commonDir, artifact) {
    return path.join(commonDir, 'libraries', artifact.path)
}

function artifactAsset(id, artifact) {
    return {
        id,
        hash: artifact.sha1 || null,
        algo: HASH_ALGO_SHA1,
        size: artifact.size || 1,
        url: artifact.url,
        path: artifact.path
    }
}

function compareVersionParts(a, b) {
    const aParts = a.split('.').map(part => Number.parseInt(part))
    const bParts = b.split('.').map(part => Number.parseInt(part))
    const len = Math.max(aParts.length, bParts.length)
    for(let i=0; i<len; i++) {
        const diff = (aParts[i] || 0) - (bParts[i] || 0)
        if(diff !== 0) {
            return diff
        }
    }
    return 0
}

function maxVersion(...versions) {
    return versions
        .filter(version => version != null && String(version).trim() !== '')
        .map(version => String(version).trim())
        .sort((a, b) => compareVersionParts(b, a))[0] || null
}

function normalizeFabricLoaderVersion(loaderVersion) {
    return maxVersion(loaderVersion, MIN_FABRIC_LOADER_VERSION, RECOMMENDED_FABRIC_LOADER_VERSION)
}

class LocalProfileBuilder {

    constructor(profile) {
        this.profile = profile
        this.commonDir = ConfigManager.getCommonDirectory()
        this.versionsDir = ConfigManager.getVersionsDirectory()
        this.modloadersDir = ConfigManager.getModloadersDirectory()
        this.gameDir = ConfigManager.getProfileInstanceDirectory(profile)
        this.mojangProcessor = new MojangIndexProcessor(this.commonDir, profile.minecraftVersion)
        this.fabricManifest = null
        this.fabricLoaderVersion = profile.loader === 'fabric'
            ? normalizeFabricLoaderVersion(profile.loaderVersion)
            : null
        this.forgeManifest = null
        this.forgeInstallProfile = null
        this.forgeVersion = profile.loaderVersion || null
        this.forgeInstallerPath = null
    }

    static isLocalProfile(profile) {
        return profile != null && (profile.loader === 'vanilla' || profile.loader === 'fabric' || profile.loader === 'forge')
    }

    static getEffectiveJavaOptions(profile) {
        return ConfigManager.getProfileJavaOptions(profile)
    }

    rawDistribution() {
        const modules = []

        switch(this.profile.loader) {
            case 'vanilla':
                break
            case 'fabric':
                modules.push({
                    id: `net.fabricmc:fabric-loader:${this.fabricLoaderVersion}`,
                    name: `Fabric Loader ${this.fabricLoaderVersion}`,
                    type: 'Fabric',
                    artifact: {
                        size: 0,
                        MD5: null,
                        url: `${FABRIC_MAVEN_ENDPOINT}net/fabricmc/fabric-loader/${this.fabricLoaderVersion}/fabric-loader-${this.fabricLoaderVersion}.jar`
                    }
                })
                break
            case 'forge':
                modules.push({
                    id: `net.minecraftforge:forge:${this.profile.minecraftVersion}-${this.forgeVersion}:universal`,
                    name: `Forge ${this.forgeVersion}`,
                    type: 'ForgeHosted',
                    artifact: {
                        size: 0,
                        MD5: null,
                        url: `${FORGE_MAVEN_ENDPOINT}net/minecraftforge/forge/${this.profile.minecraftVersion}-${this.forgeVersion}/forge-${this.profile.minecraftVersion}-${this.forgeVersion}-universal.jar`
                    },
                    subModules: this.forgeRuntimeModules()
                })
                break
            default:
                throw new Error(`Unsupported local profile loader: ${this.profile.loader}`)
        }

        return {
            version: 'local-profiles',
            discord: null,
            java: null,
            rss: null,
            servers: [
                {
                    id: this.profile.id,
                    name: this.profile.name,
                    description: 'Local profile',
                    icon: '',
                    version: 'local',
                    address: 'localhost',
                    minecraftVersion: this.profile.minecraftVersion,
                    mainServer: true,
                    autoconnect: false,
                    javaOptions: LocalProfileBuilder.getEffectiveJavaOptions(this.profile),
                    modules
                }
            ]
        }
    }

    forgeRuntimeModules() {
        if(this.forgeInstallProfile == null) {
            return []
        }

        const forgeMavenVersion = `${this.profile.minecraftVersion}-${this.forgeVersion}`
        const runtimeIds = new Set([
            `net.minecraftforge:forge:${forgeMavenVersion}:universal`,
            `net.minecraftforge:fmlcore:${forgeMavenVersion}`,
            `net.minecraftforge:javafmllanguage:${forgeMavenVersion}`,
            `net.minecraftforge:lowcodelanguage:${forgeMavenVersion}`,
            `net.minecraftforge:mclanguage:${forgeMavenVersion}`
        ])

        return (this.forgeInstallProfile.libraries || [])
            .filter(lib => runtimeIds.has(lib.name) && lib.downloads?.artifact?.url != null)
            .map(lib => ({
                id: lib.name,
                name: lib.name,
                type: 'Library',
                artifact: {
                    size: lib.downloads.artifact.size || 0,
                    MD5: null,
                    path: lib.downloads.artifact.path,
                    url: lib.downloads.artifact.url
                }
            }))
    }

    async resolveFabricLoaderVersion() {
        if(this.fabricLoaderVersion != null) {
            this.profile.loaderVersion = this.fabricLoaderVersion
            ConfigManager.saveProfiles()
            return this.fabricLoaderVersion
        }

        const res = await got.get(`${FABRIC_META_ENDPOINT}/versions/loader/${this.profile.minecraftVersion}`, { responseType: 'json' })
        const loader = res.body.find(entry => entry.loader.stable) || res.body[0]
        if(loader == null) {
            throw new Error(`No Fabric loader is available for Minecraft ${this.profile.minecraftVersion}.`)
        }
        this.fabricLoaderVersion = loader.loader.version
        this.profile.loaderVersion = this.fabricLoaderVersion
        ConfigManager.saveProfiles()
        return this.fabricLoaderVersion
    }

    async loadFabricManifest() {
        if(this.profile.loader !== 'fabric') {
            return null
        }

        await this.resolveFabricLoaderVersion()
        const fabricVersionId = `${this.profile.minecraftVersion}-fabric-${this.fabricLoaderVersion}`
        const manifestPath = path.join(this.versionsDir, fabricVersionId, `${fabricVersionId}.json`)
        if(await fs.pathExists(manifestPath)) {
            this.fabricManifest = await fs.readJson(manifestPath)
            return this.fabricManifest
        }

        const url = `${FABRIC_META_ENDPOINT}/versions/loader/${this.profile.minecraftVersion}/${this.fabricLoaderVersion}/profile/json`
        const res = await got.get(url, { responseType: 'json' })
        this.fabricManifest = res.body
        await fs.ensureDir(path.dirname(manifestPath))
        await fs.writeJson(manifestPath, this.fabricManifest)
        return this.fabricManifest
    }

    async resolveForgeVersion() {
        if(this.forgeVersion != null) {
            return this.forgeVersion
        }

        const xml = (await got.get(FORGE_METADATA_ENDPOINT)).body
        const prefix = `${this.profile.minecraftVersion}-`
        const versions = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), match => match[1])
            .filter(version => version.startsWith(prefix))
            .map(version => version.substring(prefix.length))
            .sort((a, b) => compareVersionParts(b, a))

        if(versions.length === 0) {
            throw new Error(`No official Forge build is available for Minecraft ${this.profile.minecraftVersion}.`)
        }

        this.forgeVersion = versions[0]
        this.profile.loaderVersion = this.forgeVersion
        ConfigManager.saveProfiles()
        return this.forgeVersion
    }

    async loadForgeManifest() {
        if(this.profile.loader !== 'forge') {
            return null
        }

        await this.resolveForgeVersion()
        const forgeVersionId = `${this.profile.minecraftVersion}-forge-${this.forgeVersion}`
        const manifestPath = path.join(this.versionsDir, forgeVersionId, `${forgeVersionId}.json`)
        const installProfilePath = path.join(this.modloadersDir, 'forge', forgeVersionId, 'install_profile.json')
        this.forgeInstallerPath = path.join(this.modloadersDir, 'forge', forgeVersionId, `forge-${this.profile.minecraftVersion}-${this.forgeVersion}-installer.jar`)
        if(await fs.pathExists(manifestPath) && await fs.pathExists(installProfilePath)) {
            this.forgeManifest = await fs.readJson(manifestPath)
            this.forgeInstallProfile = await fs.readJson(installProfilePath)
            this.validateOfficialForgeManifest()
            return this.forgeManifest
        }

        const forgeMavenVersion = `${this.profile.minecraftVersion}-${this.forgeVersion}`
        const installerUrl = `${FORGE_MAVEN_ENDPOINT}net/minecraftforge/forge/${forgeMavenVersion}/forge-${forgeMavenVersion}-installer.jar`
        const installerPath = this.forgeInstallerPath
        await fs.ensureDir(path.dirname(installerPath))
        await pipeline(got.stream(installerUrl), fs.createWriteStream(installerPath))

        const zip = new AdmZip(installerPath)
        const manifestEntry = zip.getEntry('version.json')
        const installProfileEntry = zip.getEntry('install_profile.json')
        if(manifestEntry == null || installProfileEntry == null) {
            throw new Error(`Forge installer ${forgeMavenVersion} does not contain the expected official manifests.`)
        }

        this.forgeManifest = JSON.parse(manifestEntry.getData().toString('utf8'))
        this.forgeInstallProfile = JSON.parse(installProfileEntry.getData().toString('utf8'))
        this.validateOfficialForgeManifest()
        await fs.ensureDir(path.dirname(manifestPath))
        await fs.ensureDir(path.dirname(installProfilePath))
        await fs.writeJson(manifestPath, this.forgeManifest)
        await fs.writeJson(installProfilePath, this.forgeInstallProfile)
        return this.forgeManifest
    }

    validateOfficialForgeManifest() {
        if(this.forgeManifest?.inheritsFrom !== this.profile.minecraftVersion) {
            throw new Error(`Forge manifest must inherit from Minecraft ${this.profile.minecraftVersion}.`)
        }
        if(!this.forgeManifest?.mainClass) {
            throw new Error('Forge manifest is missing a main class.')
        }
    }

    async init() {
        await this.mojangProcessor.init()
        switch(this.profile.loader) {
            case 'vanilla':
                break
            case 'fabric':
                await this.loadFabricManifest()
                break
            case 'forge':
                await this.loadForgeManifest()
                break
            default:
                throw new Error(`Unsupported local profile loader: ${this.profile.loader}`)
        }
        await fs.ensureDir(this.gameDir)
    }

    totalStages() {
        switch(this.profile.loader) {
            case 'vanilla':
                return 4
            case 'fabric':
            case 'forge':
                return 5
            default:
                throw new Error(`Unsupported local profile loader: ${this.profile.loader}`)
        }
    }

    async validate(onStageComplete) {
        const invalid = []
        const mojangAssets = await this.mojangProcessor.validate(onStageComplete)
        Object.values(mojangAssets).flat().forEach(asset => invalid.push(asset))

        switch(this.profile.loader) {
            case 'vanilla':
                break
            case 'fabric':
                for(const asset of await this.validateFabricLibraries()) {
                    invalid.push(asset)
                }
                await onStageComplete()
                break
            case 'forge':
                for(const asset of await this.validateForgeLibraries()) {
                    invalid.push(asset)
                }
                await onStageComplete()
                break
            default:
                throw new Error(`Unsupported local profile loader: ${this.profile.loader}`)
        }

        return invalid
    }

    async validateFabricLibraries() {
        const invalid = []
        for(const lib of this.fabricManifest.libraries || []) {
            if(lib.name == null || lib.url == null) {
                continue
            }

            const target = libraryPath(this.commonDir, lib.name)
            const hash = lib.sha1 || lib.md5 || null
            const algo = lib.sha1 ? HASH_ALGO_SHA1 : (lib.md5 ? HASH_ALGO_MD5 : HASH_ALGO_SHA1)
            if(!await validateLocalFile(target, algo, hash)) {
                invalid.push({
                    id: lib.name,
                    hash,
                    algo,
                    size: lib.size || 1,
                    url: libraryUrl(lib),
                    path: target
                })
            }
        }
        return invalid
    }

    async validateForgeLibraries() {
        const invalid = []
        const libraries = [
            ...(this.forgeManifest.libraries || []),
            ...(this.forgeInstallProfile?.libraries || [])
        ]
        const seen = new Set()

        for(const lib of libraries) {
            const artifact = lib.downloads?.artifact
            if(lib.name == null || artifact?.path == null || !isRemoteUrl(artifact.url)) {
                continue
            }

            const target = artifactPath(this.commonDir, artifact)
            if(seen.has(target)) {
                continue
            }
            seen.add(target)

            if(!await validateLocalFile(target, HASH_ALGO_SHA1, artifact.sha1 || null)) {
                const asset = artifactAsset(lib.name, artifact)
                asset.path = target
                invalid.push(asset)
            }
        }

        return invalid
    }

    async download(assets, onProgress) {
        if(assets.length === 0) {
            onProgress(100)
            return
        }

        const expectedTotalSize = Math.max(getExpectedDownloadSize(assets), assets.length)
        await downloadQueue(assets, received => {
            onProgress(Math.min(100, Math.trunc((received / expectedTotalSize) * 100)))
        })
        await this.mojangProcessor.postDownload()
    }

    async ensureForgeProcessed() {
        if(this.profile.loader !== 'forge') {
            return
        }

        await this.ensureForgeInstaller()
        const patchedPath = this.resolveForgeToken('{PATCHED}')
        const srgPath = this.resolveForgeToken('{MC_SRG}')
        const extraPath = this.resolveForgeToken('{MC_EXTRA}')
        if(await fs.pathExists(patchedPath) && await fs.pathExists(srgPath) && await fs.pathExists(extraPath)) {
            return
        }

        for(const processor of this.forgeInstallProfile.processors || []) {
            if(processor.sides != null && !processor.sides.includes('client')) {
                continue
            }
            await this.runForgeProcessor(processor)
        }
    }

    async cleanFabricRemapCache() {
        if(this.profile.loader !== 'fabric') {
            return
        }

        await fs.remove(path.join(this.gameDir, 'remappedJars'))
    }

    async ensureForgeInstaller() {
        if(await fs.pathExists(this.forgeInstallerPath)) {
            return
        }

        const forgeMavenVersion = `${this.profile.minecraftVersion}-${this.forgeVersion}`
        const installerUrl = `${FORGE_MAVEN_ENDPOINT}net/minecraftforge/forge/${forgeMavenVersion}/forge-${forgeMavenVersion}-installer.jar`
        await fs.ensureDir(path.dirname(this.forgeInstallerPath))
        await pipeline(got.stream(installerUrl), fs.createWriteStream(this.forgeInstallerPath))
    }

    async runForgeProcessor(processor) {
        const mainJar = this.resolveMavenPath(processor.jar)
        const classpath = [
            mainJar,
            ...(processor.classpath || []).map(entry => this.resolveMavenPath(entry))
        ]
        const mainClass = this.readJarMainClass(mainJar)
        const args = []
        for(const arg of processor.args || []) {
            args.push(await this.resolveForgeProcessorArg(arg))
        }

        for(const arg of args) {
            if(path.isAbsolute(arg)) {
                await fs.ensureDir(path.dirname(arg))
            }
        }

        await new Promise((resolve, reject) => {
            const proc = child_process.spawn(ConfigManager.getJavaExecutable(this.profile.id), [
                '-cp',
                classpath.join(processBuilderClasspathSeparator()),
                mainClass,
                ...args
            ], {
                cwd: this.commonDir
            })

            let stderr = ''
            proc.stdout.on('data', () => {})
            proc.stderr.on('data', data => {
                stderr += data.toString()
            })
            proc.on('error', reject)
            proc.on('close', code => {
                if(code === 0) {
                    resolve()
                } else {
                    reject(new Error(`Forge processor ${processor.jar} exited with code ${code}. ${stderr}`))
                }
            })
        })
    }

    readJarMainClass(jarPath) {
        const zip = new AdmZip(jarPath)
        const manifest = zip.getEntry('META-INF/MANIFEST.MF')
        if(manifest == null) {
            throw new Error(`Forge processor ${jarPath} has no manifest.`)
        }
        const mainClass = manifest.getData().toString('utf8').split(/\r?\n/)
            .find(line => line.toLowerCase().startsWith('main-class:'))
            ?.substring('main-class:'.length)
            .trim()
        if(!mainClass) {
            throw new Error(`Forge processor ${jarPath} has no Main-Class.`)
        }
        return mainClass
    }

    async resolveForgeProcessorArg(arg) {
        let resolved = this.replaceForgeTokens(arg)
        if(resolved.startsWith('[') && resolved.endsWith(']')) {
            resolved = this.resolveMavenPath(resolved.substring(1, resolved.length - 1))
        }
        if(resolved.startsWith('/')) {
            resolved = await this.extractForgeInstallerData(resolved.substring(1))
        }
        return resolved
    }

    replaceForgeTokens(value) {
        return value.replace(/\{([^}]+)\}/g, (_match, key) => this.resolveForgeToken(`{${key}}`))
    }

    resolveForgeToken(token) {
        const key = token.substring(1, token.length - 1)
        switch(key) {
            case 'SIDE':
                return 'client'
            case 'ROOT':
                return this.commonDir
            case 'LIBRARY_DIR':
                return path.join(this.commonDir, 'libraries')
            case 'INSTALLER':
                return this.forgeInstallerPath
            case 'MINECRAFT_VERSION':
                return this.profile.minecraftVersion
            case 'MINECRAFT_JAR':
                return path.join(this.commonDir, 'versions', this.profile.minecraftVersion, `${this.profile.minecraftVersion}.jar`)
            default: {
                const dataValue = this.forgeInstallProfile.data?.[key]?.client
                if(typeof dataValue === 'string') {
                    return this.resolveForgeDataValue(dataValue)
                }
                return token
            }
        }
    }

    resolveForgeDataValue(value) {
        if(value.startsWith('\'') && value.endsWith('\'')) {
            return value.substring(1, value.length - 1)
        }
        if(value.startsWith('[') && value.endsWith(']')) {
            return this.resolveMavenPath(value.substring(1, value.length - 1))
        }
        return this.replaceForgeTokens(value)
    }

    resolveMavenPath(identifier) {
        return path.join(this.commonDir, 'libraries', MavenUtil.mavenIdentifierAsPath(identifier))
    }

    async extractForgeInstallerData(entryName) {
        const target = path.join(this.modloadersDir, 'forge', `${this.profile.minecraftVersion}-forge-${this.forgeVersion}`, entryName)
        if(await fs.pathExists(target)) {
            return target
        }

        const zip = new AdmZip(this.forgeInstallerPath)
        const entry = zip.getEntry(entryName)
        if(entry == null) {
            throw new Error(`Forge installer is missing ${entryName}.`)
        }
        await fs.ensureDir(path.dirname(target))
        await fs.writeFile(target, entry.getData())
        return target
    }

    async getLaunchData() {
        const versionData = await this.mojangProcessor.getVersionJson()
        const distro = new HeliosDistribution(this.rawDistribution(), this.commonDir, ConfigManager.getInstanceDirectory())
        const server = distro.getServerById(this.profile.id)
        return {
            server,
            versionData,
            modLoaderData: this.getModLoaderManifest(versionData),
            gameDir: this.gameDir
        }
    }

    getModLoaderManifest(versionData) {
        switch(this.profile.loader) {
            case 'vanilla':
                return versionData
            case 'fabric':
                return this.fabricManifest
            case 'forge':
                return this.forgeManifest
            default:
                throw new Error(`Unsupported local profile loader: ${this.profile.loader}`)
        }
    }
}

function processBuilderClasspathSeparator() {
    return process.platform === 'win32' ? ';' : ':'
}

module.exports = LocalProfileBuilder
