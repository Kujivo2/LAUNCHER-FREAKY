const AdmZip = require('adm-zip')
const crypto = require('crypto')
const express = require('express')
const fs = require('fs-extra')
const got = require('got')
const multer = require('multer')
const path = require('path')

const PORT = Number(process.env.KHAERIS_ADMIN_PORT || 3030)
const MODPACK_ID = process.env.KHAERIS_MODPACK_ID || 'khaeris-fabric-1.20.1'
const WEB_ROOT = path.resolve(process.env.KHAERIS_WEB_ROOT || 'C:/xampp/htdocs/khaeris')
const PUBLIC_BASE_URL = (process.env.KHAERIS_PUBLIC_BASE_URL || 'http://localhost/khaeris').replace(/\/+$/, '')
const MANAGED_ROOTS = new Set(['mods', 'config', 'resourcepacks'])
const PACK_DIR = path.join(WEB_ROOT, 'modpacks', MODPACK_ID)
const BASE_ZIP_PATH = path.join(PACK_DIR, 'base.zip')
const UPLOAD_DIR = path.join(WEB_ROOT, 'uploads')
const DRAFT_PACK_DIR = path.join(UPLOAD_DIR, `${MODPACK_ID}-draft`)
const MANIFEST_PATH = path.join(WEB_ROOT, 'manifest.json')
const NEWS_PATH = path.join(WEB_ROOT, 'news.json')
const LAUNCHER_INFO_PATH = path.join(WEB_ROOT, 'launcher-info.json')
const DRAFT_PATH = path.join(WEB_ROOT, 'api', 'draft.json')
const PANEL_DIR = path.join(__dirname, 'public')
const MIN_FABRIC_LOADER_VERSION = '0.18.0'
const RECOMMENDED_FABRIC_LOADER_VERSION = '0.19.2'

const app = express()
const upload = multer({
    dest: UPLOAD_DIR,
    limits: {
        fileSize: 4 * 1024 * 1024 * 1024
    }
})

function ensureWebLayout() {
    fs.ensureDirSync(WEB_ROOT)
    fs.ensureDirSync(path.join(WEB_ROOT, 'api'))
    fs.ensureDirSync(path.join(WEB_ROOT, 'admin'))
    fs.ensureDirSync(path.join(WEB_ROOT, 'launcher'))
    fs.ensureDirSync(path.join(WEB_ROOT, 'modpacks'))
    fs.ensureDirSync(UPLOAD_DIR)
    ensureManagedLayoutSync(PACK_DIR)
    if(!fs.pathExistsSync(DRAFT_PACK_DIR)) {
        ensureManagedLayoutSync(DRAFT_PACK_DIR)
        copyManagedContentSync(PACK_DIR, DRAFT_PACK_DIR)
    } else {
        ensureManagedLayoutSync(DRAFT_PACK_DIR)
    }
}

function ensureManagedLayoutSync(packDir) {
    fs.ensureDirSync(packDir)
    for(const root of MANAGED_ROOTS) {
        fs.ensureDirSync(path.join(packDir, root))
    }
}

function copyManagedContentSync(sourceDir, targetDir) {
    for(const root of MANAGED_ROOTS) {
        const sourcePath = path.join(sourceDir, root)
        if(fs.pathExistsSync(sourcePath)) {
            fs.copySync(sourcePath, path.join(targetDir, root), {
                overwrite: true
            })
        }
    }
}

function asPublicUrl(...segments) {
    const suffix = segments
        .map(segment => String(segment).split('/').filter(Boolean).map(encodeURIComponent).join('/'))
        .filter(Boolean)
        .join('/')
    return `${PUBLIC_BASE_URL}/${suffix}`
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
        throw new Error('A file path is required.')
    }

    const relativePath = path.posix.normalize(filePath.trim().replace(/\\/g, '/').replace(/^\/+/, ''))
    const root = relativePath.split('/')[0]
    if(relativePath === '' || relativePath === '.' || relativePath === '..' || relativePath.startsWith('../') || !MANAGED_ROOTS.has(root)) {
        throw new Error(`Path must stay in mods, config, or resourcepacks: ${filePath}`)
    }
    return relativePath
}

function resolveManagedFile(relativePath, packDir = PACK_DIR) {
    const targetPath = path.resolve(packDir, ...relativePath.split('/'))
    if(!isPathInside(packDir, targetPath)) {
        throw new Error(`Refusing path outside modpack storage: ${relativePath}`)
    }
    return targetPath
}

function normalizeZipEntry(entryName) {
    const relativePath = path.posix.normalize(entryName.replace(/\\/g, '/').replace(/^\/+/, ''))
    if(relativePath === '.' || relativePath === '..' || relativePath.startsWith('../')) {
        return null
    }
    return relativePath
}

function getManagedZipEntry(entryName, overrideFolder = 'overrides') {
    const relativePath = normalizeZipEntry(entryName)
    if(relativePath == null) {
        return null
    }

    const parts = relativePath.split('/').filter(Boolean)
    if(parts[0] === overrideFolder) {
        parts.shift()
    }
    const managedIndex = parts.findIndex(part => MANAGED_ROOTS.has(part))
    if(managedIndex === -1) {
        return null
    }
    return normalizeManagedPath(parts.slice(managedIndex).join('/'))
}

async function ensureManagedLayout(packDir) {
    await fs.ensureDir(packDir)
    for(const root of MANAGED_ROOTS) {
        await fs.ensureDir(path.join(packDir, root))
    }
}

async function clearPackContent(packDir) {
    await ensureManagedLayout(packDir)
    for(const root of MANAGED_ROOTS) {
        await fs.remove(path.join(packDir, root))
        await fs.ensureDir(path.join(packDir, root))
    }
}

async function replaceManagedContent(sourceDir, targetDir) {
    await ensureManagedLayout(sourceDir)
    await ensureManagedLayout(targetDir)
    console.log('[Publish] Promoting draft pack:', sourceDir, '->', targetDir)
    for(const root of MANAGED_ROOTS) {
        await fs.remove(path.join(targetDir, root))
        await fs.copy(path.join(sourceDir, root), path.join(targetDir, root))
    }
}

async function sha256(filePath) {
    return await new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256')
        const input = fs.createReadStream(filePath)

        input.on('data', chunk => hash.update(chunk))
        input.on('error', reject)
        input.on('end', () => resolve(hash.digest('hex')))
    })
}

async function readJsonIfPresent(filePath, fallback) {
    if(!await fs.pathExists(filePath)) {
        return fallback
    }
    return await fs.readJson(filePath)
}

async function writeDraft(patch) {
    const draft = await readJsonIfPresent(DRAFT_PATH, {})
    const nextDraft = {
        ...draft,
        ...patch,
        modpackId: MODPACK_ID,
        updatedAt: new Date().toISOString()
    }
    await fs.writeJson(DRAFT_PATH, nextDraft, {
        spaces: 4
    })
    return nextDraft
}

async function writeJsonPublic(filePath, data) {
    await fs.ensureDir(path.dirname(filePath))
    console.log(`[Publish] Writing ${path.basename(filePath)}:`, filePath)
    await fs.writeJson(filePath, data, {
        spaces: 4
    })
    if(!fs.existsSync(filePath)) {
        throw new Error(`Publication error: expected file was not written: ${filePath}`)
    }
}

async function resetDraftFromPublic() {
    await ensureManagedLayout(PACK_DIR)
    await clearPackContent(DRAFT_PACK_DIR)
    await copyManagedContentSync(PACK_DIR, DRAFT_PACK_DIR)
}

function assertPublishedPath(filePath, label) {
    if(!fs.existsSync(filePath)) {
        throw new Error(`[Publish] ${label} missing after publish: ${filePath}`)
    }
    return filePath
}

function readZipJson(zip, entryName) {
    const entry = zip.getEntry(entryName)
    if(entry == null) {
        return null
    }
    return JSON.parse(entry.getData().toString('utf8'))
}

function parseLoaderId(loaderId) {
    const value = String(loaderId || 'vanilla').trim()
    const lower = value.toLowerCase()
    if(lower === 'vanilla') {
        return {
            loader: 'vanilla',
            loaderVersion: null
        }
    }
    if(lower === 'fabric') {
        return {
            loader: 'fabric',
            loaderVersion: null
        }
    }
    if(lower === 'forge') {
        return {
            loader: 'forge',
            loaderVersion: null
        }
    }
    if(lower.startsWith('fabric-')) {
        return {
            loader: 'fabric',
            loaderVersion: value.substring('fabric-'.length)
        }
    }
    if(lower.startsWith('forge-')) {
        return {
            loader: 'forge',
            loaderVersion: value.substring('forge-'.length)
        }
    }
    throw new Error(`Unsupported modloader in ZIP: ${loaderId}`)
}

function normalizeVersion(version, fallback = '0.0.1') {
    const match = String(version || '').match(/\d+\.\d+\.\d+/)
    return match == null ? fallback : match[0]
}

function normalizeLauncherVersion(version, fallback = 'v2.2.1') {
    const raw = String(version || '').trim()
    if(raw === '') {
        return fallback
    }
    return raw.startsWith('v') ? raw : `v${raw}`
}

function compareVersionParts(a, b) {
    const aParts = String(a || '').split('.').map(part => Number.parseInt(part))
    const bParts = String(b || '').split('.').map(part => Number.parseInt(part))
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

function normalizeLoaderVersion(loader, loaderVersion) {
    if(loader !== 'fabric') {
        return loaderVersion || null
    }
    return maxVersion(loaderVersion, MIN_FABRIC_LOADER_VERSION, RECOMMENDED_FABRIC_LOADER_VERSION)
}

function incrementVersion(version) {
    const current = normalizeVersion(version, '0.0.0').split('.').map(Number)
    current[2]++
    return current.join('.')
}

function safeUploadName(fileName) {
    const baseName = path.basename(String(fileName || '').replace(/[^\w.\- ()[\]]/g, '_'))
    if(baseName === '' || baseName === '.' || baseName === '..') {
        throw new Error('Uploaded file has no usable name.')
    }
    return baseName
}

function contentDispositionName(header, fallback) {
    if(typeof header !== 'string') {
        return fallback
    }
    const utfName = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
    if(utfName != null) {
        return safeUploadName(decodeURIComponent(utfName))
    }
    const quotedName = header.match(/filename="?([^";]+)"?/i)?.[1]
    return quotedName == null ? fallback : safeUploadName(quotedName)
}

async function extractZipContent(zip, overrideFolder, packDir) {
    let extracted = 0
    for(const entry of zip.getEntries()) {
        if(entry.isDirectory) {
            continue
        }
        const relativePath = getManagedZipEntry(entry.entryName, overrideFolder)
        if(relativePath == null) {
            continue
        }

        const targetPath = resolveManagedFile(relativePath, packDir)
        await fs.ensureDir(path.dirname(targetPath))
        await fs.writeFile(targetPath, entry.getData())
        extracted++
    }
    return extracted
}

async function mirrorCurseForgeMods(curseManifest, packDir) {
    if(!Array.isArray(curseManifest?.files) || curseManifest.files.length === 0) {
        return 0
    }

    let mirrored = 0
    for(const mod of curseManifest.files) {
        const fallback = `${mod.projectID}-${mod.fileID}.jar`
        const url = `https://www.curseforge.com/api/v1/mods/${mod.projectID}/files/${mod.fileID}/download`
        const response = await got.get(url, {
            responseType: 'buffer',
            retry: {
                limit: 1
            },
            timeout: {
                request: 60000
            }
        })
        const fileName = contentDispositionName(response.headers['content-disposition'], fallback)
        await fs.writeFile(resolveManagedFile(`mods/${fileName}`, packDir), response.body)
        mirrored++
    }
    return mirrored
}

async function useBaseZip(uploadedZip, body) {
    const zip = new AdmZip(uploadedZip.path)
    const curseManifest = readZipJson(zip, 'manifest.json')
    const loaderEntry = curseManifest?.minecraft?.modLoaders?.find(loader => loader.primary)
        || curseManifest?.minecraft?.modLoaders?.[0]
    const loaderInfo = parseLoaderId(body.loader || loaderEntry?.id || 'vanilla')
    const overrideFolder = curseManifest?.overrides || 'overrides'
    const stagingDir = path.join(UPLOAD_DIR, `${MODPACK_ID}-import-${Date.now()}`)

    await clearPackContent(stagingDir)
    try {
        const extracted = await extractZipContent(zip, overrideFolder, stagingDir)
        const mirrored = await mirrorCurseForgeMods(curseManifest, stagingDir)
        await replaceManagedContent(stagingDir, DRAFT_PACK_DIR)
        const {
            baseZipPath
        } = await createPackBaseZip(DRAFT_PACK_DIR)
        const draft = await writeDraft({
            name: body.name || curseManifest?.name || MODPACK_ID,
            version: normalizeVersion(body.versionModpack || body.version || curseManifest?.version),
            minecraftVersion: body.versionMinecraft || body.minecraftVersion || curseManifest?.minecraft?.version || '1.20.1',
            loader: loaderInfo.loader,
            loaderVersion: normalizeLoaderVersion(loaderInfo.loader, body.versionLoader || body.loaderVersion || loaderInfo.loaderVersion),
            sourceZipName: uploadedZip.originalname,
            dirty: true
        })

        return {
            draft,
            extracted,
            mirrored,
            baseZipPath
        }
    } finally {
        await fs.remove(stagingDir)
    }
}

async function walkManagedFiles(rootDir, relativeRoot = '') {
    const entries = await fs.readdir(rootDir, {
        withFileTypes: true
    })
    const files = []

    for(const entry of entries) {
        const relativePath = relativeRoot === '' ? entry.name : `${relativeRoot}/${entry.name}`
        const absolutePath = path.join(rootDir, entry.name)
        if(entry.isDirectory()) {
            files.push(...await walkManagedFiles(absolutePath, relativePath))
        } else if(entry.isFile()) {
            files.push({
                path: normalizeManagedPath(relativePath.replace(/\\/g, '/')),
                absolutePath
            })
        }
    }
    return files
}

async function listContentFiles(packDir = PACK_DIR) {
    const files = []
    for(const root of MANAGED_ROOTS) {
        files.push(...await walkManagedFiles(path.join(packDir, root), root))
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
}

async function writeBaseZip(files, packDir = PACK_DIR) {
    const zip = new AdmZip()
    for(const file of files) {
        zip.addFile(file.path, await fs.readFile(file.absolutePath))
    }
    const baseZipPath = path.join(packDir, 'base.zip')
    await fs.ensureDir(path.dirname(baseZipPath))
    zip.writeZip(baseZipPath)
    return baseZipPath
}

async function createPackBaseZip(packDir) {
    const files = await listContentFiles(packDir)
    const baseZipPath = await writeBaseZip(files, packDir)
    console.log('[Publish] Writing base.zip:', baseZipPath)
    if(!await fs.pathExists(baseZipPath)) {
        throw new Error(`Admin publication error: base.zip was not created at ${baseZipPath}`)
    }
    return {
        files,
        baseZipPath
    }
}

async function validateManifestPublication(manifest) {
    const missing = []
    const invalidUrls = []
    const expectedUrlPrefix = `${PUBLIC_BASE_URL}/`

    function validatePublicUrl(name, url) {
        if(typeof url !== 'string' || !url.startsWith(expectedUrlPrefix)) {
            invalidUrls.push({
                path: name,
                url,
                expectedPrefix: expectedUrlPrefix
            })
        }
    }

    validatePublicUrl('base.zip', manifest.baseZip)

    if(!await fs.pathExists(MANIFEST_PATH)) {
        missing.push({
            path: 'manifest.json',
            absolutePath: MANIFEST_PATH,
            url: asPublicUrl('manifest.json')
        })
    }
    if(!await fs.pathExists(BASE_ZIP_PATH)) {
        missing.push({
            path: 'base.zip',
            absolutePath: BASE_ZIP_PATH,
            url: manifest.baseZip
        })
    }
    if(!await fs.pathExists(PACK_DIR)) {
        missing.push({
            path: 'modpacks directory',
            absolutePath: PACK_DIR,
            url: asPublicUrl('modpacks', MODPACK_ID)
        })
    }

    for(const file of manifest.files) {
        const absolutePath = resolveManagedFile(file.path, PACK_DIR)
        validatePublicUrl(file.path, file.url)
        if(!await fs.pathExists(absolutePath)) {
            missing.push({
                path: file.path,
                absolutePath,
                url: file.url
            })
        }
    }

    if(invalidUrls.length > 0) {
        const details = invalidUrls.map(file => `${file.path} -> ${file.url} (expected ${file.expectedPrefix})`).join('; ')
        const error = new Error(`Admin publication error: invalid public URL(s): ${details}`)
        error.invalidUrls = invalidUrls
        throw error
    }

    if(missing.length > 0) {
        const details = missing.map(file => `${file.path} -> ${file.absolutePath} (${file.url})`).join('; ')
        const error = new Error(`Admin publication error: missing published file(s): ${details}`)
        error.missingFiles = missing
        throw error
    }

    return {
        checkedFiles: manifest.files.length + 2
    }
}

async function buildManifest(version, draft) {
    await replaceManagedContent(DRAFT_PACK_DIR, PACK_DIR)
    const {
        files,
        baseZipPath
    } = await createPackBaseZip(PACK_DIR)
    const baseStat = await fs.stat(baseZipPath)
    const manifestFiles = []

    for(const file of files) {
        const stat = await fs.stat(file.absolutePath)
        manifestFiles.push({
            path: file.path,
            url: asPublicUrl('modpacks', MODPACK_ID, file.path),
            sha256: await sha256(file.absolutePath),
            size: stat.size
        })
    }

    return {
        modpackId: MODPACK_ID,
        version,
        minecraftVersion: draft.minecraftVersion || '1.20.1',
        loader: draft.loader || 'fabric',
        loaderVersion: normalizeLoaderVersion(draft.loader || 'fabric', draft.loaderVersion),
        baseZip: asPublicUrl('modpacks', MODPACK_ID, 'base.zip'),
        baseZipSha256: await sha256(baseZipPath),
        baseZipSize: baseStat.size,
        files: manifestFiles
    }
}

async function buildLauncherInfo(versionLauncher = null, manifest = null) {
    const currentInfo = await readJsonIfPresent(LAUNCHER_INFO_PATH, {})
    const currentManifest = manifest || await readJsonIfPresent(MANIFEST_PATH, null)
    const nextVersion = normalizeLauncherVersion(versionLauncher, currentInfo.launcher?.version || 'v2.2.1')

    return {
        launcher: {
            version: nextVersion,
            updatedAt: new Date().toISOString()
        },
        modpack: {
            id: currentManifest?.modpackId || MODPACK_ID,
            version: currentManifest?.version || null,
            minecraftVersion: currentManifest?.minecraftVersion || null,
            loader: currentManifest?.loader || null,
            loaderVersion: currentManifest?.loaderVersion || null
        },
        urls: {
            manifest: asPublicUrl('manifest.json'),
            news: asPublicUrl('news.json')
        }
    }
}

async function publishLauncherInfo(versionLauncher = null, manifest = null) {
    const launcherInfo = await buildLauncherInfo(versionLauncher, manifest)
    await writeJsonPublic(LAUNCHER_INFO_PATH, launcherInfo)
    assertPublishedPath(LAUNCHER_INFO_PATH, 'launcher-info.json')
    return launcherInfo
}

async function publishDraft(versionInput = null, options = {}) {
    await fs.ensureDir(WEB_ROOT)
    await fs.ensureDir(path.join(WEB_ROOT, 'modpacks'))
    await ensureManagedLayout(DRAFT_PACK_DIR)
    const draft = await readJsonIfPresent(DRAFT_PATH, {})
    const currentManifest = await readJsonIfPresent(MANIFEST_PATH, null)
    const version = versionInput
        ? normalizeVersion(versionInput)
        : (currentManifest == null ? normalizeVersion(draft.version) : incrementVersion(currentManifest.version))
    const manifest = await buildManifest(version, draft)

    console.log('[Publish] Web root:', WEB_ROOT)
    console.log('[Publish] Pack dir:', PACK_DIR)
    console.log('[Publish] Manifest path:', MANIFEST_PATH)
    console.log('[Publish] BaseZip path:', BASE_ZIP_PATH)
    await writeJsonPublic(MANIFEST_PATH, manifest)
    await writeJsonPublic(NEWS_PATH, buildNews(version, draft))
    const launcherInfo = await publishLauncherInfo(options.versionLauncher, manifest)

    assertPublishedPath(WEB_ROOT, 'Web root')
    assertPublishedPath(path.join(WEB_ROOT, 'modpacks'), 'modpacks directory')
    assertPublishedPath(PACK_DIR, 'public modpack directory')
    assertPublishedPath(BASE_ZIP_PATH, 'base.zip')
    assertPublishedPath(MANIFEST_PATH, 'manifest.json')
    assertPublishedPath(NEWS_PATH, 'news.json')
    assertPublishedPath(LAUNCHER_INFO_PATH, 'launcher-info.json')

    const validation = await validateManifestPublication(manifest)
    await writeDraft({
        version,
        dirty: false,
        publishedAt: new Date().toISOString()
    })
    console.log('[Publish] Publish success')

    return {
        ok: true,
        message: 'Manifest publié avec succès.',
        manifestPath: MANIFEST_PATH,
        baseZipPath: BASE_ZIP_PATH,
        newsPath: NEWS_PATH,
        launcherInfoPath: LAUNCHER_INFO_PATH,
        publicManifestUrl: asPublicUrl('manifest.json'),
        publicBaseZipUrl: manifest.baseZip,
        publicNewsUrl: asPublicUrl('news.json'),
        publicLauncherInfoUrl: asPublicUrl('launcher-info.json'),
        publishChecks: {
            webRoot: fs.existsSync(WEB_ROOT),
            modpacks: fs.existsSync(path.join(WEB_ROOT, 'modpacks')),
            packDir: fs.existsSync(PACK_DIR),
            baseZip: fs.existsSync(BASE_ZIP_PATH),
            manifest: fs.existsSync(MANIFEST_PATH),
            news: fs.existsSync(NEWS_PATH),
            launcherInfo: fs.existsSync(LAUNCHER_INFO_PATH)
        },
        launcherInfo,
        manifest,
        validation
    }
}

function buildNews(version, draft) {
    return {
        news: [
            {
                section: 'latest',
                title: `Update ${version}`,
                content: draft.news || 'Le launcher verifie les fichiers et prepare ton aventure.',
                date: new Date().toISOString().slice(0, 10)
            }
        ]
    }
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

ensureWebLayout()

app.use(express.json())
app.use('/admin', express.static(PANEL_DIR))
app.use(express.static(WEB_ROOT))

app.get('/manifest.json', asyncRoute(async (_req, res) => {
    if(!await fs.pathExists(MANIFEST_PATH)) {
        res.status(404).json({
            error: 'No published manifest yet.'
        })
        return
    }
    res.sendFile(MANIFEST_PATH)
}))

app.get('/news.json', asyncRoute(async (_req, res) => {
    if(!await fs.pathExists(NEWS_PATH)) {
        res.status(404).json({
            error: 'No published news yet.'
        })
        return
    }
    res.sendFile(NEWS_PATH)
}))

app.get('/launcher-info.json', asyncRoute(async (_req, res) => {
    if(!await fs.pathExists(LAUNCHER_INFO_PATH)) {
        await publishLauncherInfo()
    }
    res.sendFile(LAUNCHER_INFO_PATH)
}))

app.get('/admin/status', asyncRoute(async (_req, res) => {
    const draft = await readJsonIfPresent(DRAFT_PATH, {})
    const manifest = await readJsonIfPresent(MANIFEST_PATH, null)
    const launcherInfo = await readJsonIfPresent(LAUNCHER_INFO_PATH, null)
    res.json({
        webRoot: WEB_ROOT,
        publicBaseUrl: PUBLIC_BASE_URL,
        modpackId: MODPACK_ID,
        draft,
        manifest,
        launcherInfo
    })
}))

app.post('/admin/upload-basezip', upload.single('baseZip'), asyncRoute(async (req, res) => {
    if(req.file == null) {
        res.status(400).json({
            error: 'baseZip upload is required.'
        })
        return
    }

    try {
        const result = await useBaseZip(req.file, req.body)
        res.json({
            ok: true,
            ...result
        })
    } finally {
        await fs.remove(req.file.path)
    }
}))

app.post('/admin/publish-full', upload.single('baseZip'), asyncRoute(async (req, res) => {
    if(req.file == null) {
        res.status(400).json({
            error: 'baseZip upload is required.'
        })
        return
    }

    try {
        const imported = await useBaseZip(req.file, req.body)
        const published = await publishDraft(req.body.versionModpack || req.body.version, {
            versionLauncher: req.body.versionLauncher
        })
        res.json({
            ...published,
            imported
        })
    } finally {
        await fs.remove(req.file.path)
    }
}))

app.post('/admin/add-file', upload.single('file'), asyncRoute(async (req, res) => {
    if(req.file == null) {
        res.status(400).json({
            error: 'file upload is required.'
        })
        return
    }

    try {
        const targetPath = normalizeManagedPath(req.body.path || `mods/${safeUploadName(req.file.originalname)}`)
        await fs.ensureDir(path.dirname(resolveManagedFile(targetPath, DRAFT_PACK_DIR)))
        await fs.move(req.file.path, resolveManagedFile(targetPath, DRAFT_PACK_DIR), {
            overwrite: true
        })
        const draft = await writeDraft({
            dirty: true
        })
        res.json({
            ok: true,
            path: targetPath,
            draft
        })
    } finally {
        await fs.remove(req.file.path)
    }
}))

app.post('/admin/publish-mods', upload.array('mods', 200), asyncRoute(async (req, res) => {
    if(!Array.isArray(req.files) || req.files.length === 0) {
        res.status(400).json({
            error: 'At least one .jar file is required.'
        })
        return
    }

    const added = []
    try {
        for(const file of req.files) {
            if(!file.originalname.toLowerCase().endsWith('.jar')) {
                throw new Error(`Only .jar files are accepted: ${file.originalname}`)
            }
        }

        await resetDraftFromPublic()
        for(const file of req.files) {
            const targetPath = normalizeManagedPath(`mods/${safeUploadName(file.originalname)}`)
            const absolutePath = resolveManagedFile(targetPath, DRAFT_PACK_DIR)
            await fs.ensureDir(path.dirname(absolutePath))
            await fs.move(file.path, absolutePath, {
                overwrite: true
            })
            added.push(targetPath)
        }

        await writeDraft({
            dirty: true,
            news: `${added.length} mod(s) ajoute(s) au modpack.`
        })
        const published = await publishDraft(req.body.versionModpack || req.body.version, {
            versionLauncher: req.body.versionLauncher
        })
        res.json({
            ...published,
            added
        })
    } finally {
        for(const file of req.files || []) {
            await fs.remove(file.path)
        }
    }
}))

app.post('/admin/publish-launcher-info', asyncRoute(async (req, res) => {
    const launcherInfo = await publishLauncherInfo(req.body.versionLauncher)
    res.json({
        ok: true,
        message: 'Version launcher publiée avec succès.',
        launcherInfoPath: LAUNCHER_INFO_PATH,
        publicLauncherInfoUrl: asPublicUrl('launcher-info.json'),
        launcherInfo
    })
}))

app.delete('/admin/remove-file', asyncRoute(async (req, res) => {
    const targetPath = normalizeManagedPath(req.body.path)
    await fs.remove(resolveManagedFile(targetPath, DRAFT_PACK_DIR))
    const draft = await writeDraft({
        dirty: true
    })
    res.json({
        ok: true,
        path: targetPath,
        draft
    })
}))

app.post('/admin/publish', asyncRoute(async (req, res) => {
    await fs.ensureDir(WEB_ROOT)
    await fs.ensureDir(path.join(WEB_ROOT, 'modpacks'))
    await ensureManagedLayout(DRAFT_PACK_DIR)
    const draft = await readJsonIfPresent(DRAFT_PATH, {})
    const currentManifest = await readJsonIfPresent(MANIFEST_PATH, null)
    const version = req.body.version
        ? normalizeVersion(req.body.version)
        : (currentManifest == null ? normalizeVersion(draft.version) : incrementVersion(currentManifest.version))
    const manifest = await buildManifest(version, draft)

    console.log('[Publish] Web root:', WEB_ROOT)
    console.log('[Publish] Pack dir:', PACK_DIR)
    console.log('[Publish] Manifest path:', MANIFEST_PATH)
    console.log('[Publish] BaseZip path:', BASE_ZIP_PATH)
    await writeJsonPublic(MANIFEST_PATH, manifest)
    await writeJsonPublic(NEWS_PATH, buildNews(version, draft))

    assertPublishedPath(WEB_ROOT, 'Web root')
    assertPublishedPath(path.join(WEB_ROOT, 'modpacks'), 'modpacks directory')
    assertPublishedPath(PACK_DIR, 'public modpack directory')
    assertPublishedPath(BASE_ZIP_PATH, 'base.zip')
    assertPublishedPath(MANIFEST_PATH, 'manifest.json')
    assertPublishedPath(NEWS_PATH, 'news.json')

    const validation = await validateManifestPublication(manifest)
    await writeDraft({
        version,
        dirty: false,
        publishedAt: new Date().toISOString()
    })
    console.log('[Publish] Publish success')
    res.json({
        ok: true,
        message: 'Manifest publié avec succès.',
        manifestPath: MANIFEST_PATH,
        baseZipPath: BASE_ZIP_PATH,
        newsPath: NEWS_PATH,
        publicManifestUrl: asPublicUrl('manifest.json'),
        publicBaseZipUrl: manifest.baseZip,
        publicNewsUrl: asPublicUrl('news.json'),
        publishChecks: {
            webRoot: fs.existsSync(WEB_ROOT),
            modpacks: fs.existsSync(path.join(WEB_ROOT, 'modpacks')),
            packDir: fs.existsSync(PACK_DIR),
            baseZip: fs.existsSync(BASE_ZIP_PATH),
            manifest: fs.existsSync(MANIFEST_PATH),
            news: fs.existsSync(NEWS_PATH)
        },
        manifest,
        validation
    })
}))

app.use((err, _req, res, _next) => {
    console.error(err)
    res.status(500).json({
        error: err.message || 'Unexpected admin server error.',
        missingFiles: err.missingFiles,
        invalidUrls: err.invalidUrls
    })
})

app.listen(PORT, () => {
    console.log(`Khaeris admin panel: http://localhost:${PORT}/admin/`)
    console.log(`Khaeris web root: ${WEB_ROOT}`)
    console.log(`Khaeris public base URL: ${PUBLIC_BASE_URL}`)
    console.log(`Khaeris manifest path: ${MANIFEST_PATH}`)
    console.log(`Khaeris base.zip path: ${BASE_ZIP_PATH}`)
    console.log(`Khaeris news path: ${NEWS_PATH}`)
    console.log(`Khaeris launcher info path: ${LAUNCHER_INFO_PATH}`)
})
