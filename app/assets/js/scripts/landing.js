/**
 * Script for landing.ejs
 */
// Requirements
const { URL }                 = require('url')
const semver                  = require('semver')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const LocalProfileBuilder     = require('./assets/js/localprofilebuilder')
const ProcessBuilder          = require('./assets/js/processbuilder')
const SimpleModpackManager    = require('./assets/js/simplemodpackmanager')
const LauncherConfig          = require('./assets/js/launcherconfig')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')
const launcherOnlineLimit     = 50
const repair_modpack_button   = document.getElementById('repair_modpack_button')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

function setRepairEnabled(val){
    if(repair_modpack_button != null) {
        repair_modpack_button.disabled = !val
    }
}

function updateSimpleModpackProgress(progress) {
    if(progress.phase === 'manifest') {
        setLaunchDetails('Verification du modpack...')
        setLaunchPercentage(0, 100)
        return
    }
    if(progress.phase === 'repair') {
        setLaunchDetails('Reparation du modpack...')
        setLaunchPercentage(0, 100)
        return
    }
    if(progress.phase === 'baseZip') {
        setLaunchDetails('Telechargement du modpack de base')
    } else if(progress.phase === 'runtimeCheck') {
        setLaunchDetails(`Verification runtime: ${progress.file}`)
    } else if(progress.phase === 'runtimeDownload') {
        setLaunchDetails(`Installation runtime: ${progress.file}`)
    } else if(progress.phase === 'extract') {
        setLaunchDetails(`Installation de ${progress.file}`)
    } else if(progress.phase === 'fileDownload' || progress.phase === 'fileDownloadProgress') {
        setLaunchDetails(`Mise a jour de ${progress.file}`)
    } else if(progress.phase === 'fileCheck') {
        setLaunchDetails(`Verification de ${progress.file}`)
    } else if(progress.phase === 'cleanup') {
        setLaunchDetails(`Suppression de ${progress.file}`)
    } else if(progress.phase === 'done') {
        setLaunchDetails('Modpack pret')
        setLaunchPercentage(100)
        return
    }

    if(progress.bytesTotal > 0) {
        setDownloadPercentage(Math.min(100, Math.trunc((progress.transferred / progress.bytesTotal) * 100)))
    } else if(progress.total > 0) {
        setLaunchPercentage(Math.trunc((progress.current / progress.total) * 100))
    }
}

async function launchSelectedLocalProfile(profile) {
    ConfigManager.ensureProfileJavaConfig(profile)
    ConfigManager.save()
    const effectiveJavaOptions = LocalProfileBuilder.getEffectiveJavaOptions(profile)
    const jExe = ConfigManager.getJavaExecutable(profile.id)
    if(jExe == null){
        await asyncSystemScan(effectiveJavaOptions)
    } else {

        setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
        toggleLaunchArea(true)
        setLaunchPercentage(0, 100)

        const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), effectiveJavaOptions.supported)
        if(details != null){
            loggerLanding.info('Jvm Details', details)
            await dlAsync()

        } else {
            await asyncSystemScan(effectiveJavaOptions)
        }
    }
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    if(e.currentTarget.disabled) {
        return
    }
    loggerLanding.info('Launching game..')
    setLaunchEnabled(false)
    setRepairEnabled(false)
    setLaunchDetails('Verification du modpack...')
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)
    try {
        const profile = await SimpleModpackManager.ensureLaunchProfile()
        ConfigManager.setSelectedProfile(profile.id)
        ConfigManager.save()
        await launchSelectedLocalProfile(profile)
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        setLaunchEnabled(true)
        setRepairEnabled(true)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), err.message || Lang.queryJS('landing.launch.failureText'))
    }
})

repair_modpack_button?.addEventListener('click', async e => {
    if(e.currentTarget.disabled) {
        return
    }
    loggerLanding.info('Repairing Khaeris modpack..')
    setLaunchEnabled(false)
    setRepairEnabled(false)
    setLaunchDetails('Reparation du modpack...')
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)
    try {
        const sync = await SimpleModpackManager.repairModpack(updateSimpleModpackProgress)
        loggerLanding.info(`Repair complete for ${sync.manifest.version}: ${sync.downloaded.length} file(s) downloaded, ${sync.removed.length} file(s) removed.`)
        setLaunchDetails('Modpack repare')
        setLaunchPercentage(100)
        setTimeout(() => {
            toggleLaunchArea(false)
            setLaunchEnabled(true)
            setRepairEnabled(true)
        }, 900)
    } catch(err) {
        loggerLanding.error('Unable to repair the simple modpack.', err)
        setLaunchEnabled(true)
        setRepairEnabled(true)
        showLaunchFailure('Erreur de reparation du modpack', err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
    } finally {
        remote.getCurrentWindow().setProgressBar(-1)
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.querySelector('.settingsNavItem[rSc="settingsTabMinecraft"]'), false)
    })
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/avatar/${authUser.uuid}/64')`
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = 'Launcher'
    let pVal = `0/${launcherOnlineLimit}`
    let isOnline = true

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pVal = `${Math.min(servStat.players.online, launcherOnlineLimit)}/${launcherOnlineLimit}`

    } catch (err) {
        loggerLanding.warn('Unable to refresh online count, showing launcher capacity fallback.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            document.getElementById('server_status_wrapper').setAttribute('status', isOnline ? 'online' : 'offline')
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
        document.getElementById('server_status_wrapper').setAttribute('status', isOnline ? 'online' : 'offline')
    }
    
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setLaunchEnabled(true)
    setRepairEnabled(true)
    remote.getCurrentWindow().setProgressBar(-1)
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(getLaunchJavaConfigId(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(getLaunchJavaConfigId(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+|Setting user: .+)$/
const MIN_LINGER = 5000

function getLaunchJavaConfigId() {
    const profile = ConfigManager.getSelectedProfile()
    return LocalProfileBuilder.isLocalProfile(profile) ? profile.id : ConfigManager.getSelectedServer()
}

function findInvalidModuleArtifactUrl(modules) {
    for(const module of modules) {
        const url = module.rawModule.artifact?.url
        if(typeof url !== 'string' || !/^https?:\/\//.test(url)) {
            return module.rawModule
        }

        if(module.hasSubModules()) {
            const invalidSubModule = findInvalidModuleArtifactUrl(module.subModules)
            if(invalidSubModule != null) {
                return invalidSubModule
            }
        }
    }

    return null
}

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')
    const localProfile = ConfigManager.getSelectedProfile()
    if(LocalProfileBuilder.isLocalProfile(localProfile)) {
        await dlLocalProfileAsync(localProfile, login, loggerLaunchSuite)
        return
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())
    const invalidModule = findInvalidModuleArtifactUrl(serv.modules)
    if(invalidModule != null) {
        loggerLaunchSuite.error(`Invalid artifact URL for module ${invalidModule.id}: ${invalidModule.artifact?.url}`)
        showLaunchFailure(
            Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'),
            `Invalid download URL for ${invalidModule.name || invalidModule.id}. Check the distribution index.`
        )
        return
    }

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            setLaunchEnabled(true)
            setRepairEnabled(true)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

async function dlLocalProfileAsync(profile, login, loggerLaunchSuite) {
    if(login && ConfigManager.getSelectedAccount() == null){
        loggerLanding.error('You must be logged into an account.')
        return
    }

    if(SimpleModpackManager.isSimpleProfile(profile)) {
        setLaunchDetails('Verification du modpack...')
        toggleLaunchArea(true)
        setLaunchPercentage(0, 100)
        try {
            const sync = await SimpleModpackManager.syncModpack(updateSimpleModpackProgress)
            Object.assign(profile, sync.profile)
            loggerLaunchSuite.info(`Simple modpack ${sync.manifest.version}: ${sync.downloaded.length} file(s) downloaded, ${sync.removed.length} file(s) removed.`)
            setLaunchPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Unable to synchronize the simple modpack.', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    }

    const builder = new LocalProfileBuilder(profile)

    setLaunchDetails('Préparation du profil local')
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    try {
        await builder.init()
    } catch(err) {
        loggerLaunchSuite.error('Unable to prepare local profile.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }

    loggerLaunchSuite.info('Validating local profile files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    const totalStages = builder.totalStages()
    let completedStages = 0
    let invalidAssets = []
    try {
        invalidAssets = await builder.validate(async () => {
            completedStages++
            setLaunchPercentage(Math.trunc((completedStages / totalStages) * 100))
        })
        setLaunchPercentage(100)
    } catch(err) {
        loggerLaunchSuite.error('Error during local profile validation.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }

    if(invalidAssets.length > 0) {
        loggerLaunchSuite.info(`Downloading ${invalidAssets.length} local profile files.`)
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await builder.download(invalidAssets, percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during local profile download.', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid local profile files, skipping download.')
    }

    remote.getCurrentWindow().setProgressBar(-1)
    if(profile.loader === 'forge') {
        setLaunchDetails('Génération des fichiers Forge')
        try {
            await builder.ensureForgeProcessed()
        } catch(err) {
            loggerLaunchSuite.error('Error during Forge processor execution.', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    }
    if(profile.loader === 'fabric') {
        setLaunchDetails('Nettoyage du cache Fabric')
        try {
            await builder.cleanFabricRemapCache()
        } catch(err) {
            loggerLaunchSuite.error('Error while cleaning Fabric remap cache.', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.message || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    }
    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        const launchData = await builder.getLaunchData()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) and local profile (${profile.name}) to ProcessBuilder.`)
        const pb = new ProcessBuilder(launchData.server, launchData.versionData, launchData.modLoaderData, authUser, remote.app.getVersion(), {
            gameDir: launchData.gameDir
        })
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            setLaunchEnabled(true)
            setRepairEnabled(true)
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            loggerLaunchSuite.error(data)
        }

        try {
            proc = pb.build()
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)
            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))
        } catch(err) {
            loggerLaunchSuite.error('Error during local profile launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))
        }
    }
}

/**
 * News Loading Functions
 */

// DOM Cache
const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')

// News slide caches.
let newsActive = false
let newsGlideCount = 0

/**
 * Show the news UI via a slide animation.
 * 
 * @param {boolean} up True to slide up, otherwise false. 
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    newsGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'
        //date.toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})
        //landingContainer.style.background = 'rgba(29, 29, 29, 0.55)'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(newsGlideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}

// Bind news button.
document.getElementById('newsButton').onclick = () => {
    // Toggle tabbing.
    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}

document.getElementById('serverHomeNewsButton')?.addEventListener('click', () => {
    document.getElementById('newsButton').click()
})

// Array to store article meta.
let newsArr = null

// News load animation listener.
let newsLoadingListener = null

/**
 * Set the news loading animation.
 * 
 * @param {boolean} val True to set loading animation, otherwise false.
 */
function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}

// Bind retry button.
newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}

/**
 * Reload the news without restarting.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false

/**
 * Show the news alert indicating there is new news.
 */
function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}

/**
 * Initialize News UI. This will load the news and prepare
 * the UI accordingly.
 * 
 * @returns {Promise.<void>} A promise which resolves when the news
 * content has finished loading and transitioning.
 */
async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        // News Loading Failed
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {
        // No News Articles
        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {
        // Success
        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){

                // Compare Content
                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)
    
            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}

/**
 * Add keyboard controls to the news UI. Left and right arrows toggle
 * between articles. If you are on the landing page, the up arrow will
 * open the news UI.
 */
document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }
        // Interferes with scrolling an article using the down arrow.
        // Not sure of a straight forward solution at this point.
        // if(e.key === 'ArrowDown'){
        //     document.getElementById('newsButton').click()
        // }
    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})

/**
 * Display a news article on the UI.
 * 
 * @param {Object} articleObject The article meta object.
 * @param {number} index The article index.
 */
function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = 'by ' + articleObject.author
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)
}

/**
 * Load news information from the RSS feed specified in the
 * distribution index.
 */
async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    if(!distroData.rawDistribution.rss) {
        loggerLanding.debug('No RSS feed provided.')
        return null
    }

    const promise = new Promise((resolve, reject) => {
        
        const newsFeed = distroData.rawDistribution.rss
        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){
                // JQuery Element
                    const el = $(items[i])

                    // Resolve date.
                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})

                    // Resolve comments.
                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')

                    // Fix relative links in content.
                    let content = el.find('content\\:encoded').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()

                    // Generate article.
                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}

async function checkModpackUpdate(){

    try {
        const res = await fetch(LauncherConfig.MANIFEST_URL, { cache: 'no-store' })
        const data = await res.json()

        console.log('MODPACK MANIFEST:', data)

    } catch(err){
        console.error('Erreur API modpack:', err)
    }
}

function escapeInfoHTML(value){
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;')
}

function renderInfoMarkdown(value){
    let html = escapeInfoHTML(value)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
    html = html.replace(/`(.+?)`/g, '<code>$1</code>')
    html = html.replace(/\n/g, '<br>')
    return html
}

function normalizeInfoItems(data){
    const fallback = {
        latest: {
            title: 'Le serveur attend ton arrivee.',
            content: 'Le launcher verifie les fichiers et garde ton aventure prete avant chaque partie.'
        },
        mods: {
            title: 'Modpack synchronise',
            content: 'Les nouveaux mods et changements seront affiches ici.'
        },
        server: {
            title: 'Khaeris en ligne',
            content: 'Retrouve ici les informations importantes du serveur.'
        },
        events: {
            title: 'Aucune annonce',
            content: 'Les prochains events apparaitront dans cette section.'
        },
        maintenance: {
            title: 'Operationnel',
            content: 'Aucune maintenance signalee.'
        }
    }

    const items = Object.assign({}, fallback)
    const news = Array.isArray(data?.news) ? data.news : []

    if(news[0] != null){
        items.latest = news[0]
    }

    for(const entry of news){
        const section = String(entry.section || entry.type || '').toLowerCase()
        if(section.includes('mod')){
            items.mods = entry
        } else if(section.includes('server') || section.includes('serveur')){
            items.server = entry
        } else if(section.includes('event') || section.includes('annonce')){
            items.events = entry
        } else if(section.includes('maintenance') || section.includes('status')){
            items.maintenance = entry
        }
    }

    return items
}

function setInfoCard(section, item){
    const card = document.querySelector(`.launcherInfoCard[data-news-section="${section}"]`)
    if(card == null){
        return
    }

    const title = item?.title || 'Information'
    const content = item?.content || item?.description || ''
    const date = item?.date ? `<time>${escapeInfoHTML(item.date)}</time>` : ''

    if(card.id === 'launcherInfoCardSingle'){
        card.innerHTML = `
            <div class="launcherInfoCardTop">
                <span class="launcherInfoKicker">Derniere actualite</span>
                <span class="launcherInfoBadge">Update</span>
            </div>
            <h2>${escapeInfoHTML(title)}</h2>
            <p>${renderInfoMarkdown(content)}</p>
            ${date}
            <button id="serverHomeNewsButton" type="button">Voir le changelog</button>
        `
        document.getElementById('serverHomeNewsButton')?.addEventListener('click', () => {
            document.getElementById('newsButton').click()
        })
    } else {
        card.innerHTML = `
            <span class="launcherInfoKicker">${card.querySelector('.launcherInfoKicker')?.innerHTML || ''}</span>
            <h2>${escapeInfoHTML(title)}</h2>
            <p>${renderInfoMarkdown(content)}</p>
            ${date}
        `
    }
}

async function refreshLauncherInfoPanel(){
    const panel = document.getElementById('launcherInfoPanel')
    if(panel == null){
        return
    }

    try {
        const res = await fetch(LauncherConfig.NEWS_URL, { cache: 'no-store' })
        if(!res.ok){
            throw new Error(`HTTP ${res.status}`)
        }
        const data = await res.json()
        const items = normalizeInfoItems(data)
        setInfoCard('latest', items.latest)
        setInfoCard('mods', items.mods)
        setInfoCard('server', items.server)
        setInfoCard('events', items.events)
        setInfoCard('maintenance', items.maintenance)
        panel.setAttribute('data-state', 'loaded')
    } catch(err){
        loggerLanding.warn('Unable to load launcher news panel, using fallback content.')
        loggerLanding.debug(err)
        const items = normalizeInfoItems(null)
        setInfoCard('latest', items.latest)
        setInfoCard('mods', items.mods)
        setInfoCard('server', items.server)
        setInfoCard('events', items.events)
        setInfoCard('maintenance', items.maintenance)
        panel.setAttribute('data-state', 'fallback')
    }
}

async function refreshLauncherInfoVersion(){
    const versionTarget = document.getElementById('serverRailLauncherVersion')
    const modpackTarget = document.getElementById('serverRailModpackVersion')
    const minecraftTarget = document.getElementById('serverRailMinecraftVersion')
    const loaderTarget = document.getElementById('serverRailLoaderVersion')
    if(versionTarget == null){
        return
    }

    versionTarget.textContent = `v${remote.app.getVersion()}`

    try {
        const res = await fetch(LauncherConfig.MANIFEST_URL, { cache: 'no-store' })
        if(!res.ok){
            throw new Error(`HTTP ${res.status}`)
        }
        const data = await res.json()
        if(modpackTarget != null){
            modpackTarget.textContent = data.version || '-'
        }
        if(minecraftTarget != null){
            minecraftTarget.textContent = data.minecraftVersion || '-'
        }
        if(loaderTarget != null){
            loaderTarget.textContent = data.loader
                ? `${data.loader}${data.loaderVersion ? ` ${data.loaderVersion}` : ''}`
                : '-'
        }
        if(typeof data?.launcher?.version === 'string'){
            const remoteVersion = data.launcher.version.replace(/^v/, '')
            if(semver.valid(remoteVersion) && semver.gt(remoteVersion, remote.app.getVersion())){
                document.getElementById('image_seal_container')?.setAttribute('update', true)
                if(!isDev){
                    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                }
            }
        }
    } catch(err){
        loggerLanding.warn('Unable to load manifest versions, keeping bundled values.')
        loggerLanding.debug(err)
    }
}

checkModpackUpdate()
refreshLauncherInfoPanel()
refreshLauncherInfoVersion()
