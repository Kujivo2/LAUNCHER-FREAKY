// profiles.js - manage create profile modal and creation
(() => {
    if(window.__khaerisProfilesInitialized === true) {
        return
    }
    window.__khaerisProfilesInitialized = true

    function requireProfileDependency(paths) {
        let lastError = null
        for(const dependencyPath of paths) {
            try {
                return require(dependencyPath)
            } catch(err) {
                lastError = err
            }
        }
        throw lastError
    }

    const ProfilesConfigManager = requireProfileDependency(['./assets/js/configmanager', '../configmanager'])
    const ProfilesGot = require('got')
    const ProfilesFs = require('fs-extra')
    const ProfilesPath = require('path')
    const ProfilesZip = require('adm-zip')
    const { shell: ProfilesShell } = require('electron')
    const profilesLogger = require('helios-core').LoggerUtil.getLogger('Profiles')

    const MOJANG_VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
    const FABRIC_LOADER_ENDPOINT = 'https://meta.fabricmc.net/v2/versions/loader'
    const FORGE_METADATA_ENDPOINT = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
    const MODPACK_IMPORT_ROOTS = new Set([
        'mods',
        'config',
        'resourcepacks',
        'shaderpacks',
        'saves',
        'scripts',
        'kubejs',
        'defaultconfigs',
        'journeymap',
        'options.txt',
        'servers.dat'
    ])
    // Elements
    const createProfileBtn = document.getElementById('showProfileCreatePage') || document.getElementById('createProfileButton') || document.getElementById('create_profile_button')
    const landingProfilesPanel = document.getElementById('landingProfilesPanel')
    const selectProfileBtn = document.getElementById('showProfileSelectPage')
    const modpackProfileBtn = document.getElementById('showProfileModpackPage')
    const createProfileForm = document.getElementById('createProfileForm')
    const modpackProfileForm = document.getElementById('modpackProfileForm')
    const createProfileConfirm = document.getElementById('create_profile_confirm')
    const createProfileCancel = document.getElementById('create_profile_cancel')
    const modpackZipSelect = document.getElementById('profile_modpack_zip_select')
    const modpackZipFile = document.getElementById('profile_modpack_file')
    const modpackZipStatus = document.getElementById('profile_modpack_status')
    const modpackProgress = document.getElementById('profile_modpack_progress')
    const modpackProgressBar = document.getElementById('profile_modpack_progress_bar')
    const modpackProgressText = document.getElementById('profile_modpack_progress_text')
    const profileModalBackdrop = document.getElementById('profileModalBackdrop')
    const closeCreateProfileModal = document.getElementById('close_create_profile_modal')
    const closeModpackProfileModal = document.getElementById('close_modpack_profile_modal')
    const profileLibraryCount = document.getElementById('profileLibraryCount')
    const profileSelectionBtn = document.getElementById('profile_selection_button')
    const profilesListContainer = document.getElementById('profiles_list_container')
    const profileMcVersion = document.getElementById('profile_mcversion')
    const profileLoader = document.getElementById('profile_loader')
    const profileLoaderVersion = document.getElementById('profile_loaderversion')
    const profileVersionStatus = document.getElementById('profile_version_status')
    const profileHeaderMenuButton = document.getElementById('profileHeaderMenuButton')
    const profileHeaderActionMenu = document.getElementById('profileHeaderActionMenu')
    const profileDetailView = document.getElementById('profileDetailView')
    const profileDetailImage = document.getElementById('profileDetailImage')
    const profileDetailName = document.getElementById('profileDetailName')
    const profileDetailAuthor = document.getElementById('profileDetailAuthor')
    const profileDetailVersion = document.getElementById('profileDetailVersion')
    const profileDetailLoader = document.getElementById('profileDetailLoader')
    const profileDetailMenuButton = document.getElementById('profileDetailMenuButton')
    const profileDetailActionMenu = document.getElementById('profileDetailActionMenu')
    const profileDetailPlayButton = document.getElementById('profileDetailPlayButton')
    const profileContentCount = document.getElementById('profileContentCount')
    const profileModsCount = document.getElementById('profileModsCount')
    const profileModsList = document.getElementById('profileModsList')
    const profileAddContentButton = document.getElementById('profileAddContentButton')

    let minecraftVersionsCache = null
    let forgeVersionsCache = null
    let detailProfileId = null

    function setProfileHeaderMenuOpen(open) {
        if(profileHeaderActionMenu == null || profileHeaderMenuButton == null) {
            return
        }
        profileHeaderActionMenu.style.display = open ? 'flex' : 'none'
        profileHeaderMenuButton.setAttribute('open', open ? 'true' : 'false')
    }

    function setProfileDetailMenuOpen(open) {
        if(profileDetailActionMenu == null || profileDetailMenuButton == null) {
            return
        }
        profileDetailActionMenu.style.display = open ? 'flex' : 'none'
        profileDetailMenuButton.setAttribute('open', open ? 'true' : 'false')
    }

    function getSelectedProfileForAction() {
        const profile = ProfilesConfigManager.getSelectedProfile()
        if(profile == null) {
            alert('Selectionne un modpack avant d utiliser ce menu.')
        }
        return profile
    }

    function getDetailOrSelectedProfile() {
        const profiles = ProfilesConfigManager.getProfiles()
        return profiles.find(profile => profile.id === detailProfileId) || ProfilesConfigManager.getSelectedProfile()
    }

    function profileModsDirectory(profile) {
        return ProfilesPath.join(ProfilesConfigManager.getProfileInstanceDirectory(profile), 'mods')
    }

    function readProfileMods(profile) {
        const modsDir = profileModsDirectory(profile)
        if(!ProfilesFs.existsSync(modsDir)) {
            return []
        }
        return ProfilesFs.readdirSync(modsDir)
            .filter(fileName => fileName.toLowerCase().endsWith('.jar'))
            .sort((a, b) => a.localeCompare(b))
    }

    function formatModName(fileName) {
        return fileName
            .replace(/\.jar$/i, '')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+\d[\w.+-]*$/i, '')
            .trim()
            .replace(/\b\w/g, char => char.toUpperCase())
    }

    function renderProfileMods(profile) {
        if(profileModsList == null) {
            return
        }

        const mods = readProfileMods(profile)
        if(profileContentCount != null) {
            profileContentCount.textContent = `(${mods.length})`
        }
        if(profileModsCount != null) {
            profileModsCount.textContent = `(${mods.length})`
        }

        profileModsList.innerHTML = ''
        if(mods.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'profileModEmpty'
            empty.textContent = 'Aucun mod trouve dans le dossier mods.'
            profileModsList.appendChild(empty)
            return
        }

        for(const fileName of mods) {
            const row = document.createElement('div')
            row.className = 'profileModRow'
            row.innerHTML = `
                <span class="profileModCheckbox"></span>
                <span class="profileModName"><strong>${formatModName(fileName)}</strong><small>${fileName}</small></span>
            `
            profileModsList.appendChild(row)
        }
    }

    function showProfileDetail(profile) {
        detailProfileId = profile.id
        ProfilesConfigManager.setSelectedProfile(profile.id)
        ProfilesConfigManager.save()
        refreshProfileButton()

        if(profileDetailImage != null) {
            profileDetailImage.style.backgroundImage = profileAccent(profile)
        }
        if(profileDetailName != null) {
            profileDetailName.textContent = profile.name
        }
        if(profileDetailAuthor != null) {
            profileDetailAuthor.textContent = 'My creation'
        }
        if(profileDetailVersion != null) {
            profileDetailVersion.textContent = profile.minecraftVersion || 'local'
        }
        if(profileDetailLoader != null) {
            const loader = profile.loader || 'vanilla'
            profileDetailLoader.textContent = profile.loaderVersion ? `${loader} - ${profile.loaderVersion}` : loader
        }

        profilesListContainer.style.display = 'none'
        profileLibraryToolbar.style.display = 'none'
        if(profileDetailView != null) {
            profileDetailView.style.display = 'block'
        }
        landingProfilesPanel?.setAttribute('detail-open', 'true')
        renderProfileMods(profile)
    }

    function showProfileLibrary() {
        detailProfileId = null
        if(profileDetailView != null) {
            profileDetailView.style.display = 'none'
        }
        profileLibraryToolbar.style.display = 'flex'
        profilesListContainer.style.display = 'grid'
        landingProfilesPanel?.removeAttribute('detail-open')
    }

    async function openProfileFolder(profile) {
        const instanceDir = ProfilesConfigManager.getProfileInstanceDirectory(profile)
        await ProfilesFs.ensureDir(instanceDir)
        ProfilesShell.openPath(instanceDir)
    }

    async function openProfileModsFolder(profile) {
        const modsDir = profileModsDirectory(profile)
        await ProfilesFs.ensureDir(modsDir)
        ProfilesShell.openPath(modsDir)
    }

    function deleteProfile(profile) {
        if(!confirm(`Supprimer le profil "${profile.name}" et ses fichiers locaux ?`)) {
            return
        }

        try {
            ProfilesConfigManager.deleteProfile(profile.id, true)
            profilesLogger.info('Deleted profile', profile)
            detailProfileId = null
            refreshProfileButton()
            refreshProfileList()
            showProfileLibrary()
        } catch(err) {
            profilesLogger.error('Failed to delete profile', err)
            alert('Erreur lors de la suppression du profil')
        }
    }

    async function openSelectedProfileModsFolder() {
        const profile = getSelectedProfileForAction()
        if(profile == null) {
            return
        }
        await openProfileModsFolder(profile)
    }

    async function openSelectedProfileSettings() {
        const profile = getSelectedProfileForAction()
        if(profile == null) {
            return
        }
        ProfilesConfigManager.setSelectedProfile(profile.id)
        ProfilesConfigManager.save()
        refreshProfileButton()
        refreshProfileList()
        if(typeof prepareSettings === 'function' && typeof switchView === 'function') {
            await prepareSettings()
            switchView(getCurrentView(), VIEWS.settings)
        }
    }

    function launchSelectedProfileFromHeader() {
        const profile = getSelectedProfileForAction()
        if(profile == null) {
            return
        }
        ProfilesConfigManager.setSelectedProfile(profile.id)
        ProfilesConfigManager.save()
        refreshProfileButton()
        refreshProfileList()
        document.getElementById('launch_button').click()
    }

    profileHeaderMenuButton?.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        setProfileHeaderMenuOpen(profileHeaderActionMenu.style.display === 'none')
    })

    profileHeaderActionMenu?.addEventListener('click', e => {
        const item = e.target.closest('.profileHeaderActionItem')
        if(item == null) {
            return
        }
        e.preventDefault()
        e.stopPropagation()
        setProfileHeaderMenuOpen(false)
        switch(item.getAttribute('data-action')) {
            case 'run':
            case 'repair':
                launchSelectedProfileFromHeader()
                break
            case 'mods':
                openSelectedProfileModsFolder().catch(err => profilesLogger.error('Failed to open selected profile mods folder', err))
                break
            case 'settings':
                openSelectedProfileSettings().catch(err => profilesLogger.error('Failed to open selected profile settings', err))
                break
        }
    })

    profileDetailMenuButton?.addEventListener('click', e => {
        e.preventDefault()
        e.stopPropagation()
        setProfileDetailMenuOpen(profileDetailActionMenu.style.display === 'none')
    })

    profileDetailActionMenu?.addEventListener('click', e => {
        const item = e.target.closest('.profileHeaderActionItem')
        const profile = getDetailOrSelectedProfile()
        if(item == null || profile == null) {
            return
        }
        e.preventDefault()
        e.stopPropagation()
        setProfileDetailMenuOpen(false)
        switch(item.getAttribute('data-action')) {
            case 'mods':
            case 'folder':
                openProfileModsFolder(profile).catch(err => profilesLogger.error('Failed to open profile mods folder', err))
                break
            case 'delete':
                deleteProfile(profile)
                break
            default:
                alert('Option pas encore disponible.')
        }
    })

    profileDetailPlayButton?.addEventListener('click', e => {
        e.preventDefault()
        launchSelectedProfileFromHeader()
    })

    profileAddContentButton?.addEventListener('click', e => {
        e.preventDefault()
        const profile = getDetailOrSelectedProfile()
        if(profile != null) {
            openProfileModsFolder(profile).catch(err => profilesLogger.error('Failed to open profile mods folder', err))
        }
    })

    document.addEventListener('click', e => {
        if(e.target.closest('#profileHeaderMenu') == null) {
            setProfileHeaderMenuOpen(false)
        }
        if(e.target.closest('#profileDetailActions') == null) {
            setProfileDetailMenuOpen(false)
        }
    })

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

    function createProfileSlug(name) {
        const baseSlug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '') || 'profile'
        const existingProfiles = ProfilesConfigManager.getProfiles()
        const existingIds = new Set(existingProfiles.map(profile => profile.id))
        const existingInstanceDirs = new Set(existingProfiles.map(profile => profile.instanceDir))
        let slug = baseSlug
        let suffix = 2
        while(existingIds.has(slug) || existingInstanceDirs.has(slug)) {
            slug = `${baseSlug}-${suffix}`
            suffix++
        }
        return slug
    }

    function createLocalProfile(name, minecraftVersion, loader, loaderVersion) {
        const slug = createProfileSlug(name)
        return {
            id: slug,
            name,
            minecraftVersion,
            loader,
            loaderVersion,
            instanceDir: slug
        }
    }

    function saveCreatedProfile(profile) {
        ProfilesConfigManager.createProfile(profile)
        ProfilesConfigManager.ensureProfileJavaConfig(profile)
        ProfilesConfigManager.setSelectedProfile(profile.id)
        ProfilesConfigManager.save()
        profilesLogger.info('Created profile', profile)
        refreshProfileButton()
        refreshProfileList()
    }

    function setModpackStatus(text, status = null) {
        if(modpackZipStatus == null) {
            return
        }
        modpackZipStatus.textContent = text || ''
        if(status == null) {
            modpackZipStatus.removeAttribute('status')
        } else {
            modpackZipStatus.setAttribute('status', status)
        }
    }

    function setModpackProgress(current, total, label = '') {
        if(modpackProgress == null || modpackProgressBar == null || modpackProgressText == null) {
            return
        }

        const active = total > 0
        const percent = active ? Math.min(100, Math.max(0, Math.trunc((current / total) * 100))) : 0
        modpackProgress.setAttribute('active', active ? 'true' : 'false')
        modpackProgress.setAttribute('aria-hidden', active ? 'false' : 'true')
        modpackProgressBar.style.width = `${percent}%`
        modpackProgressText.textContent = active ? `${label}${label ? ' - ' : ''}${current}/${total} (${percent}%)` : ''
    }

    function resetModpackImportUi() {
        if(modpackZipFile != null) {
            modpackZipFile.textContent = 'Aucun fichier selectionne'
        }
        setModpackProgress(0, 0)
    }

    function setProfileModal(open) {
        if(profileModalBackdrop == null) {
            return
        }
        profileModalBackdrop.style.display = open ? 'flex' : 'none'
        profileModalBackdrop.setAttribute('open', open ? 'true' : 'false')
    }

    function profileAccent(profile) {
        const keys = ['fabric', 'forge', 'vanilla']
        const index = Math.max(0, keys.indexOf(profile.loader || 'vanilla'))
        return [
            'linear-gradient(135deg, rgba(44, 132, 255, 0.95), rgba(26, 24, 34, 0.92)), url("assets/images/backgrounds/1.jpg")',
            'linear-gradient(135deg, rgba(255, 107, 45, 0.95), rgba(28, 22, 18, 0.92)), url("assets/images/backgrounds/4.jpg")',
            'linear-gradient(135deg, rgba(70, 160, 82, 0.92), rgba(20, 26, 18, 0.92)), url("assets/images/backgrounds/2.jpg")'
        ][index]
    }

    function normalizeModpackEntryName(entryName) {
        return entryName.replace(/\\/g, '/').replace(/^\/+/, '')
    }

    function shouldSkipModpackEntry(entryName) {
        return entryName === '' || entryName === '.DS_Store' || entryName.startsWith('__MACOSX/') || entryName.endsWith('/.DS_Store')
    }

    function readZipJson(zip, entryName) {
        const entry = zip.getEntry(entryName)
        if(entry == null) {
            return null
        }
        try {
            return JSON.parse(entry.getData().toString('utf8'))
        } catch(err) {
            profilesLogger.warn(`Impossible de lire ${entryName} dans le modpack`, err)
            return null
        }
    }

    function parseLoaderId(loaderId) {
        if(typeof loaderId !== 'string' || loaderId.trim() === '') {
            return {
                loader: 'vanilla',
                loaderVersion: null
            }
        }

        const value = loaderId.trim()
        const lower = value.toLowerCase()

        if(lower.startsWith('forge-')) {
            return {
                loader: 'forge',
                loaderVersion: value.substring('forge-'.length)
            }
        }
        if(lower.startsWith('fabric-')) {
            return {
                loader: 'fabric',
                loaderVersion: value.substring('fabric-'.length)
            }
        }
        if(lower === 'vanilla') {
            return {
                loader: 'vanilla',
                loaderVersion: null
            }
        }

        if(lower.includes('neoforge') || lower.startsWith('quilt-')) {
            throw new Error(`Loader non supporte par le launcher: ${loaderId}`)
        }

        throw new Error(`Loader impossible a lire: ${loaderId}`)
    }

    function detectCurseForgeModpack(zip, zipPath) {
        const manifest = readZipJson(zip, 'manifest.json')
        if(manifest?.minecraft?.version == null) {
            return null
        }

        const loaderEntry = (manifest.minecraft.modLoaders || []).find(loader => loader.primary) || manifest.minecraft.modLoaders?.[0]
        const loaderInfo = parseLoaderId(loaderEntry?.id || 'vanilla')

        return {
            name: manifest.name || ProfilesPath.basename(zipPath, ProfilesPath.extname(zipPath)),
            minecraftVersion: manifest.minecraft.version,
            loader: loaderInfo.loader,
            loaderVersion: loaderInfo.loaderVersion
        }
    }

    function detectModrinthModpack(zip, zipPath) {
        const index = readZipJson(zip, 'modrinth.index.json')
        if(index?.dependencies?.minecraft == null) {
            return null
        }

        const dependencies = index.dependencies
        let loader = 'vanilla'
        let loaderVersion = null

        if(dependencies['fabric-loader'] != null) {
            loader = 'fabric'
            loaderVersion = dependencies['fabric-loader']
        } else if(dependencies.forge != null) {
            loader = 'forge'
            loaderVersion = dependencies.forge
        } else if(dependencies.neoforge != null || dependencies['quilt-loader'] != null) {
            throw new Error('Ce loader de modpack n\'est pas encore supporte par le launcher.')
        }

        return {
            name: index.name || ProfilesPath.basename(zipPath, ProfilesPath.extname(zipPath)),
            minecraftVersion: dependencies.minecraft,
            loader,
            loaderVersion
        }
    }

    function detectMultiMcModpack(zip, zipPath) {
        const pack = readZipJson(zip, 'mmc-pack.json')
        if(!Array.isArray(pack?.components)) {
            return null
        }

        const minecraft = pack.components.find(component => component.uid === 'net.minecraft')
        const forge = pack.components.find(component => component.uid === 'net.minecraftforge')
        const fabric = pack.components.find(component => component.uid === 'net.fabricmc.fabric-loader')
        const unsupported = pack.components.find(component => component.uid === 'org.quiltmc.quilt-loader' || component.uid === 'net.neoforged')

        if(minecraft?.version == null) {
            return null
        }
        if(unsupported != null) {
            throw new Error('Ce loader de modpack n\'est pas encore supporte par le launcher.')
        }

        return {
            name: ProfilesPath.basename(zipPath, ProfilesPath.extname(zipPath)),
            minecraftVersion: minecraft.version,
            loader: forge != null ? 'forge' : (fabric != null ? 'fabric' : 'vanilla'),
            loaderVersion: forge?.version || fabric?.version || null
        }
    }

    function detectModpackProfile(zip, zipPath) {
        const detected = detectCurseForgeModpack(zip, zipPath)
            || detectModrinthModpack(zip, zipPath)
            || detectMultiMcModpack(zip, zipPath)

        if(detected == null) {
            throw new Error('Impossible de detecter la version Minecraft et le modloader du ZIP.')
        }
        if(detected.loader !== 'vanilla' && detected.loaderVersion == null) {
            throw new Error('Version du modloader introuvable dans le ZIP.')
        }

        return detected
    }

    function entryLooksLikeMinecraftContent(entryName) {
        const parts = entryName.split('/')
        return MODPACK_IMPORT_ROOTS.has(parts[0])
    }

    function entryLooksLikeDotMinecraftContent(entryName) {
        const parts = entryName.split('/')
        return parts[0] === '.minecraft' && MODPACK_IMPORT_ROOTS.has(parts[1])
    }

    function isAllowedModpackRelativePath(relativePath) {
        return entryLooksLikeMinecraftContent(relativePath)
    }

    function getPrefixedImportItems(entries, prefixes) {
        return entries.map(item => {
            const prefix = prefixes.find(candidate => item.name.startsWith(candidate))
            if(prefix == null) {
                return null
            }

            const relativePath = item.name.substring(prefix.length)
            if(shouldSkipModpackEntry(relativePath)) {
                return null
            }
            if(!isAllowedModpackRelativePath(relativePath)) {
                return null
            }

            return {
                entry: item.entry,
                relativePath
            }
        }).filter(item => item != null)
    }

    function getModpackImportItems(zip) {
        const entries = zip.getEntries()
            .map(entry => ({
                entry,
                name: normalizeModpackEntryName(entry.entryName)
            }))
            .filter(item => !shouldSkipModpackEntry(item.name))

        const fileNames = entries
            .filter(item => !item.entry.isDirectory)
            .map(item => item.name)

        const topLevel = new Set(fileNames.map(name => name.split('/')[0]).filter(Boolean))
        const basePrefixes = ['']
        if(topLevel.size === 1) {
            basePrefixes.push(`${Array.from(topLevel)[0]}/`)
        }

        for(const basePrefix of basePrefixes) {
            const overridePrefixes = [`${basePrefix}overrides/`, `${basePrefix}client-overrides/`]
            if(fileNames.some(name => overridePrefixes.some(prefix => name.startsWith(prefix)))) {
                return getPrefixedImportItems(entries, overridePrefixes)
            }

            const dotMinecraftPrefix = `${basePrefix}.minecraft/`
            if(fileNames.some(name => name.startsWith(dotMinecraftPrefix) && entryLooksLikeDotMinecraftContent(name.substring(basePrefix.length)))) {
                return getPrefixedImportItems(entries, [dotMinecraftPrefix])
            }

            const rootFileNames = fileNames
                .filter(name => name.startsWith(basePrefix))
                .map(name => name.substring(basePrefix.length))

            if(basePrefix !== '' && rootFileNames.some(entryLooksLikeMinecraftContent)) {
                return getPrefixedImportItems(entries, [basePrefix])
            }
        }

        return entries.map(item => ({
            entry: item.entry,
            relativePath: item.name
        })).filter(item => isAllowedModpackRelativePath(item.relativePath))
    }

    function isPathInside(baseDir, targetPath) {
        const base = ProfilesPath.resolve(baseDir)
        const target = ProfilesPath.resolve(targetPath)
        const compareBase = process.platform === 'win32' ? base.toLowerCase() : base
        const compareTarget = process.platform === 'win32' ? target.toLowerCase() : target
        return compareTarget === compareBase || compareTarget.startsWith(compareBase + ProfilesPath.sep)
    }

    function resolveSafeModpackPath(instanceDir, relativePath) {
        const target = ProfilesPath.resolve(instanceDir, relativePath)
        if(!isPathInside(instanceDir, target)) {
            throw new Error(`Chemin refuse dans le ZIP: ${relativePath}`)
        }
        return target
    }

    function importModpackFiles(zip, profile) {
        const instanceDir = ProfilesConfigManager.getProfileInstanceDirectory(profile)
        const importItems = getModpackImportItems(zip)
        const plannedItems = importItems.map(item => ({
            entry: item.entry,
            destination: resolveSafeModpackPath(instanceDir, item.relativePath)
        }))

        ProfilesFs.ensureDirSync(instanceDir)

        let fileCount = 0
        for(const item of plannedItems) {
            const destination = item.destination
            if(item.entry.isDirectory) {
                ProfilesFs.ensureDirSync(destination)
            } else {
                ProfilesFs.ensureDirSync(ProfilesPath.dirname(destination))
                ProfilesFs.writeFileSync(destination, item.entry.getData())
                fileCount++
            }
        }

        return fileCount
    }

    function getFileNameFromContentDisposition(header) {
        if(typeof header !== 'string') {
            return null
        }

        const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i)
        if(utf8Match != null) {
            return decodeURIComponent(utf8Match[1].trim().replace(/^"|"$/g, ''))
        }

        const match = header.match(/filename="?([^";]+)"?/i)
        return match == null ? null : match[1].trim()
    }

    function getFileNameFromUrl(url) {
        try {
            const parsed = new URL(url)
            const fileName = ProfilesPath.basename(parsed.pathname)
            return fileName === '' ? null : decodeURIComponent(fileName)
        } catch(_err) {
            return null
        }
    }

    async function downloadUrlToFile(url, destination) {
        const res = await ProfilesGot.get(url, {
            responseType: 'buffer',
            followRedirect: true,
            timeout: {
                request: 120000
            }
        })
        const contentType = res.headers['content-type'] || ''
        if(contentType.includes('text/html')) {
            throw new Error(`Telechargement refuse, la source a retourne une page web: ${url}`)
        }

        ProfilesFs.ensureDirSync(ProfilesPath.dirname(destination))
        ProfilesFs.writeFileSync(destination, res.body)
        return res
    }

    async function downloadModrinthFiles(zip, profile, onProgress) {
        const index = readZipJson(zip, 'modrinth.index.json')
        if(!Array.isArray(index?.files)) {
            return 0
        }

        const instanceDir = ProfilesConfigManager.getProfileInstanceDirectory(profile)
        const files = index.files.filter(file => file?.env?.client !== 'unsupported' && Array.isArray(file.downloads) && file.downloads.length > 0)
        let downloaded = 0

        for(const file of files) {
            const destination = resolveSafeModpackPath(instanceDir, file.path)
            if(!isAllowedModpackRelativePath(file.path)) {
                continue
            }
            onProgress?.(downloaded + 1, files.length)
            await downloadUrlToFile(file.downloads[0], destination)
            downloaded++
        }

        return downloaded
    }

    async function downloadCurseForgeFiles(zip, profile, onProgress) {
        const manifest = readZipJson(zip, 'manifest.json')
        if(!Array.isArray(manifest?.files)) {
            return 0
        }

        const instanceDir = ProfilesConfigManager.getProfileInstanceDirectory(profile)
        let downloaded = 0

        for(const file of manifest.files) {
            if(file?.projectID == null || file?.fileID == null) {
                continue
            }

            onProgress?.(downloaded + 1, manifest.files.length)
            const url = `https://www.curseforge.com/api/v1/mods/${file.projectID}/files/${file.fileID}/download`
            const tempDestination = resolveSafeModpackPath(instanceDir, `mods/${file.projectID}-${file.fileID}.jar`)
            const res = await downloadUrlToFile(url, tempDestination)
            const fileName = getFileNameFromContentDisposition(res.headers['content-disposition'])
                || getFileNameFromUrl(res.url)
                || `${file.projectID}-${file.fileID}.jar`
            const finalDestination = resolveSafeModpackPath(instanceDir, `mods/${fileName}`)
            if(finalDestination !== tempDestination) {
                ProfilesFs.moveSync(tempDestination, finalDestination, { overwrite: true })
            }
            downloaded++
        }

        return downloaded
    }

    async function downloadModpackManifestFiles(zip, profile, onProgress) {
        if(readZipJson(zip, 'modrinth.index.json') != null) {
            return await downloadModrinthFiles(zip, profile, onProgress)
        }
        if(readZipJson(zip, 'manifest.json') != null) {
            return await downloadCurseForgeFiles(zip, profile, onProgress)
        }
        return 0
    }

    function setVersionStatus(text) {
        profileVersionStatus.textContent = text || ''
    }

    function setLoaderVersionOptions(options, emptyText) {
        profileLoaderVersion.innerHTML = ''
        if(emptyText != null) {
            const option = document.createElement('option')
            option.value = ''
            option.textContent = emptyText
            profileLoaderVersion.appendChild(option)
        }
        for(const entry of options) {
            const option = document.createElement('option')
            option.value = entry.value
            option.textContent = entry.label
            profileLoaderVersion.appendChild(option)
        }
    }

    function setMinecraftVersionOptions(options, emptyText) {
        profileMcVersion.innerHTML = ''
        if(emptyText != null) {
            const option = document.createElement('option')
            option.value = ''
            option.textContent = emptyText
            profileMcVersion.appendChild(option)
        }
        for(const entry of options) {
            const option = document.createElement('option')
            option.value = entry.id
            option.textContent = entry.label
            profileMcVersion.appendChild(option)
        }
    }

    async function loadMinecraftVersions() {
        if(minecraftVersionsCache != null) {
            return minecraftVersionsCache
        }

        const manifest = (await ProfilesGot.get(MOJANG_VERSION_MANIFEST, { responseType: 'json' })).body
        minecraftVersionsCache = manifest.versions.map(version => ({
            id: version.id,
            type: version.type
        }))
        return minecraftVersionsCache
    }

    async function populateMinecraftVersions() {
        setVersionStatus('Chargement des versions Minecraft...')
        setMinecraftVersionOptions([], 'Chargement...')
        const versions = await loadMinecraftVersions()
        setMinecraftVersionOptions(versions.map(version => ({
            id: version.id,
            label: `${version.id}${version.type === 'snapshot' ? ' (snapshot)' : ''}`
        })))
        profileMcVersion.value = versions.find(version => version.type === 'release')?.id || versions[0]?.id || ''
        setVersionStatus('')
    }

    async function loadForgeVersions() {
        if(forgeVersionsCache != null) {
            return forgeVersionsCache
        }

        const xml = (await ProfilesGot.get(FORGE_METADATA_ENDPOINT)).body
        forgeVersionsCache = Array.from(xml.matchAll(/<version>([^<]+)<\/version>/g), match => match[1])
        return forgeVersionsCache
    }

    async function populateLoaderVersions() {
        const mcVersion = profileMcVersion.value
        const loader = profileLoader.value
        profileLoaderVersion.disabled = loader === 'vanilla'

        if(loader === 'vanilla') {
            setLoaderVersionOptions([], 'Vanilla')
            setVersionStatus('')
            return
        }

        if(!mcVersion) {
            setLoaderVersionOptions([], 'Choisis une version Minecraft')
            return
        }

        try {
            if(loader === 'fabric') {
                setVersionStatus('Chargement des loaders Fabric...')
                const loaders = (await ProfilesGot.get(`${FABRIC_LOADER_ENDPOINT}/${mcVersion}`, { responseType: 'json' })).body
                const options = loaders.map(entry => ({
                    value: entry.loader.version,
                    label: `${entry.loader.version}${entry.loader.stable ? ' (stable)' : ''}`
                }))
                setLoaderVersionOptions(options, options.length > 0 ? 'Auto stable' : 'Aucune version Fabric compatible')
            } else if(loader === 'forge') {
                setVersionStatus('Chargement des builds Forge officielles...')
                const forgeVersions = await loadForgeVersions()
                const options = forgeVersions
                    .filter(version => version.startsWith(`${mcVersion}-`))
                    .map(version => version.substring(mcVersion.length + 1))
                    .sort((a, b) => compareVersionParts(b, a))
                    .map(version => ({
                        value: version,
                        label: version
                    }))
                setLoaderVersionOptions(options, options.length > 0 ? null : 'Aucune build Forge compatible')
            }
        } catch(err) {
            profilesLogger.error('Failed to load loader versions', err)
            setLoaderVersionOptions([], 'Impossible de charger les versions')
        } finally {
            setVersionStatus('')
        }
    }

    function showProfileSelectPage() {
        showProfileLibrary()
        createProfileForm.style.display = 'none'
        modpackProfileForm.style.display = 'none'
        setProfileModal(false)
        selectProfileBtn?.setAttribute('selected', '')
        createProfileBtn?.removeAttribute('selected')
        modpackProfileBtn?.removeAttribute('selected')
    }

    async function showCreateProfile(){
        showProfileLibrary()
        createProfileForm.style.display = 'flex'
        modpackProfileForm.style.display = 'none'
        setProfileModal(true)
        createProfileBtn?.setAttribute('selected', '')
        selectProfileBtn?.removeAttribute('selected')
        modpackProfileBtn?.removeAttribute('selected')
        if(minecraftVersionsCache == null) {
            try {
                await populateMinecraftVersions()
            } catch(err) {
                profilesLogger.error('Failed to load Minecraft versions', err)
                setMinecraftVersionOptions([], 'Impossible de charger les versions')
                setVersionStatus('Vérifie ta connexion puis réessaie.')
            }
        }
        await populateLoaderVersions()
    }

    function showModpackProfile(){
        showProfileLibrary()
        createProfileForm.style.display = 'none'
        modpackProfileForm.style.display = 'flex'
        setProfileModal(true)
        modpackProfileBtn?.setAttribute('selected', '')
        selectProfileBtn?.removeAttribute('selected')
        createProfileBtn?.removeAttribute('selected')
        setModpackStatus('', null)
        setModpackProgress(0, 0)
    }

    function hideCreateProfile(){
        document.getElementById('profile_name').value = ''
        profileLoader.value = 'vanilla'
        populateLoaderVersions()
    }

    window.openCreateProfileModal = showCreateProfile

    if(selectProfileBtn != null) {
        selectProfileBtn.textContent = 'Profils'
    }
    if(createProfileBtn != null) {
        createProfileBtn.textContent = 'Creer'
    }
    if(modpackProfileBtn != null) {
        modpackProfileBtn.textContent = 'Modpack ZIP'
    }
    createProfileConfirm.textContent = 'Creer'
    createProfileCancel.textContent = 'Annuler'

    if(createProfileBtn != null) {
        createProfileBtn.addEventListener('click', e => {
            e.preventDefault()
            showCreateProfile().catch(err => {
                profilesLogger.error('Failed to prepare create profile form', err)
                setVersionStatus('Impossible de charger les versions.')
            })
        })
    }
    selectProfileBtn?.addEventListener('click', e => {
        e.preventDefault()
        showProfileSelectPage()
    })
    modpackProfileBtn?.addEventListener('click', e => {
        e.preventDefault()
        showModpackProfile()
    })
    createProfileCancel.addEventListener('click', e => {
        e.preventDefault()
        hideCreateProfile()
        showProfileSelectPage()
    })
    closeCreateProfileModal?.addEventListener('click', e => {
        e.preventDefault()
        showProfileSelectPage()
    })
    closeModpackProfileModal?.addEventListener('click', e => {
        e.preventDefault()
        showProfileSelectPage()
    })
    profileModalBackdrop?.addEventListener('click', e => {
        if(e.target === profileModalBackdrop) {
            showProfileSelectPage()
        }
    })

    profileMcVersion.addEventListener('change', () => {
        populateLoaderVersions()
    })

    profileLoader.addEventListener('change', () => {
        populateLoaderVersions()
    })

    createProfileConfirm.addEventListener('click', async e => {
        e.preventDefault()
        const name = document.getElementById('profile_name').value.trim()
        const mcver = profileMcVersion.value || null
        const loader = profileLoader.value || 'vanilla'
        const loaderv = profileLoaderVersion.value || null

        if(!name){
            alert('Veuillez fournir un nom pour le profil')
            return
        }
        if(!mcver){
            alert('Veuillez fournir une version Minecraft pour le profil')
            return
        }
        if(loader !== 'vanilla' && loader !== 'fabric' && loader !== 'forge'){
            alert('Seuls Vanilla, Fabric et Forge sont disponibles pour le moment')
            return
        }
        if(loader === 'forge' && !loaderv){
            alert('Veuillez choisir une version Forge officielle')
            return
        }

        const profile = createLocalProfile(name, mcver, loader, loaderv)
        try{
            saveCreatedProfile(profile)
            alert('Profil créé: ' + name)
            hideCreateProfile()
            showProfileSelectPage()
        } catch(err){
            profilesLogger.error('Failed to create profile', err)
            alert('Erreur lors de la création du profil')
        }
    })

    async function importModpackZip(zipPath, queueIndex, queueTotal) {
        const queueLabel = queueTotal > 1 ? ` (${queueIndex}/${queueTotal})` : ''
        modpackZipFile.textContent = zipPath

        let profile = null
        try {
            setModpackStatus(`Lecture du modpack${queueLabel}...`, 'pending')
            setModpackProgress(0, 0)

            const zip = new ProfilesZip(zipPath)
            const detectedProfile = detectModpackProfile(zip, zipPath)
            profile = createLocalProfile(
                detectedProfile.name,
                detectedProfile.minecraftVersion,
                detectedProfile.loader,
                detectedProfile.loaderVersion
            )

            setModpackStatus(`Profil detecte: ${profile.minecraftVersion} - ${profile.loader}${profile.loaderVersion ? ` ${profile.loaderVersion}` : ''}`, 'pending')
            saveCreatedProfile(profile)
            const importedFiles = importModpackFiles(zip, profile)
            const downloadedFiles = await downloadModpackManifestFiles(zip, profile, (current, total) => {
                setModpackStatus(`Telechargement des mods${queueLabel}...`, 'pending')
                setModpackProgress(current, total, ProfilesPath.basename(zipPath))
            })

            setModpackProgress(downloadedFiles, downloadedFiles, ProfilesPath.basename(zipPath))
            setModpackStatus(`${profile.name}: ${importedFiles} fichier(s) importe(s), ${downloadedFiles} mod(s) telecharge(s).`, 'success')
            return true
        } catch(err) {
            profilesLogger.error('Failed to import modpack', err)
            if(profile != null) {
                try {
                    ProfilesConfigManager.deleteProfile(profile.id, true)
                    refreshProfileButton()
                    refreshProfileList()
                } catch(deleteErr) {
                    profilesLogger.error('Failed to clean failed modpack profile', deleteErr)
                }
            }
            setModpackStatus(err.message || 'Erreur pendant import du modpack.', 'error')
            alert(err.message || 'Erreur pendant import du modpack.')
            return false
        }
    }

    if(modpackZipSelect != null) {
        modpackZipSelect.addEventListener('click', async e => {
            e.preventDefault()

            const res = await remote.dialog.showOpenDialog(remote.getCurrentWindow(), {
                title: 'Ajouter un ou plusieurs modpacks.zip',
                properties: ['openFile', 'multiSelections'],
                filters: [
                    { name: 'Modpack ZIP', extensions: ['zip'] }
                ]
            })

            if(res.canceled || res.filePaths.length === 0) {
                return
            }

            let successCount = 0
            modpackZipSelect.disabled = true
            modpackZipSelect.textContent = 'Import en cours...'

            try {
                for(let i=0; i<res.filePaths.length; i++) {
                    const imported = await importModpackZip(res.filePaths[i], i + 1, res.filePaths.length)
                    if(imported) {
                        successCount++
                    }
                }

                resetModpackImportUi()
                setModpackStatus(`${successCount}/${res.filePaths.length} modpack(s) importe(s). Tu peux en ajouter d'autres ou cliquer sur Jouer.`, successCount === res.filePaths.length ? 'success' : 'error')
            } finally {
                modpackZipSelect.disabled = false
                modpackZipSelect.textContent = 'Ajouter un modpack.zip'
            }
        })
    }

    function refreshProfileButton(){
        const sel = ProfilesConfigManager.getSelectedProfile()
        if(sel){
            profileSelectionBtn.innerHTML = `Profil: ${sel.name}`
            document.getElementById('launch_button').disabled = false
        } else {
            profileSelectionBtn.innerHTML = 'Profil: Aucun'
        }
    }

    function refreshProfileList(){
        profilesListContainer.innerHTML = ''
        const profiles = ProfilesConfigManager.getProfiles()
        const selectedProfile = ProfilesConfigManager.getSelectedProfile()
        if(profileLibraryCount != null) {
            profileLibraryCount.textContent = `${profiles.length} profil${profiles.length === 1 ? '' : 's'}`
        }

        function selectProfile(profile) {
            ProfilesConfigManager.setSelectedProfile(profile.id)
            ProfilesConfigManager.save()
            refreshProfileButton()
            refreshProfileList()
        }

        if(profiles.length === 0){
            const emptyState = document.createElement('div')
            emptyState.id = 'profilesEmptyState'
            emptyState.innerHTML = '<span class="profilesEmptyTitle">Aucun profil local</span><span class="profilesEmptyText">Crée un profil Vanilla, Fabric ou Forge pour préparer une instance séparée.</span>'
            profilesListContainer.appendChild(emptyState)
        } else {
            for(let p of profiles){
                const el = document.createElement('div')
                el.className = 'profileRow'
                if(selectedProfile?.id === p.id) {
                    el.setAttribute('selected', '')
                }

                const profileInfo = document.createElement('button')
                profileInfo.className = 'profileInfoButton'
                profileInfo.type = 'button'

                const art = document.createElement('div')
                art.className = 'profileArt'
                art.style.backgroundImage = profileAccent(p)

                const badges = document.createElement('div')
                badges.className = 'profileBadges'
                const loaderBadge = document.createElement('span')
                loaderBadge.textContent = p.loader || 'vanilla'
                const versionBadge = document.createElement('span')
                versionBadge.textContent = p.minecraftVersion || 'local'
                badges.appendChild(loaderBadge)
                badges.appendChild(versionBadge)

                const name = document.createElement('span')
                name.className = 'profileName'
                name.textContent = p.name

                const meta = document.createElement('span')
                meta.className = 'profileMeta'
                meta.textContent = [p.minecraftVersion, p.loader || 'vanilla', p.loaderVersion].filter(Boolean).join(' - ')

                const launchProfile = document.createElement('button')
                launchProfile.className = 'profileLaunchButton'
                launchProfile.type = 'button'
                launchProfile.textContent = 'Play'

                art.appendChild(badges)
                profileInfo.appendChild(name)
                profileInfo.appendChild(meta)
                profileInfo.addEventListener('click', () => {
                    selectProfile(p)
                })
                launchProfile.addEventListener('click', e => {
                    e.preventDefault()
                    e.stopPropagation()
                    selectProfile(p)
                    document.getElementById('launch_button').click()
                })
                el.appendChild(art)
                el.appendChild(profileInfo)
                el.appendChild(launchProfile)
                profilesListContainer.appendChild(el)
            }
        }
    }

    profileSelectionBtn.addEventListener('click', e => {
        e.preventDefault()
        profilesListContainer.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })

    // Initialize button text on load
    refreshProfileButton()
    refreshProfileList()
    showProfileSelectPage()
})()
