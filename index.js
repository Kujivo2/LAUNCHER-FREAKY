const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

// Requirements
const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const crypto                            = require('crypto')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MICROSOFT_REDIRECT_URI, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const LangLoader                        = require('./app/assets/js/langloader')
const LauncherConfig                    = require('./app/assets/js/launcherconfig')

// Setup Lang
LangLoader.setupLanguage()

// Setup auto updater.
function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    } else {
        // Defaults to true if application version contains prerelease components (e.g. 0.12.1-alpha.1)
        // autoUpdater.allowPrerelease = true
    }
    
    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    } else {
        autoUpdater.setFeedURL({
            provider: 'generic',
            url: LauncherConfig.LAUNCHER_UPDATE_URL
        })
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    }) 
}

// Open channel to listen for update actions.
ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            autoUpdater.quitAndInstall()
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})

// Redirect distribution index event from preloader to renderer.
ipcMain.on('distributionIndexDone', (event, res) => {
    event.sender.send('distributionIndexDone', res)
})

// Handle trash item.
ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Disable hardware acceleration.
// https://electronjs.org/docs/tutorial/offscreen-rendering
app.disableHardwareAcceleration()


const MICROSOFT_AUTHORIZE_ENDPOINT = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'
const LEGACY_HELIOS_CLIENT_ID = '1ce6e35a-126f-48fd-97fb-54d143ac6d45'

function base64Url(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
}

function isValidMicrosoftClientId(clientId) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
        && clientId.toLowerCase() !== LEGACY_HELIOS_CLIENT_ID
}

// Microsoft Auth Login
let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    if(!isValidMicrosoftClientId(AZURE_CLIENT_ID)) {
        ipcEvent.reply(
            MSFT_OPCODE.REPLY_LOGIN,
            MSFT_REPLY_TYPE.ERROR,
            MSFT_ERROR.CONFIGURATION,
            msftAuthViewOnClose,
            'Renseigne minecraftAuth.microsoftClientId dans package.json avec ton propre Application (client) ID Microsoft Entra.'
        )
        return
    }

    msftAuthSuccess = false
    const codeVerifier = base64Url(crypto.randomBytes(64))
    const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
    const oauthState = base64Url(crypto.randomBytes(32))
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    const handleMicrosoftRedirect = (uri) => {
        if(!uri.startsWith(MICROSOFT_REDIRECT_URI) || msftAuthSuccess) {
            return
        }

        const queryMap = {}
        new URL(uri).searchParams.forEach((value, key) => {
            queryMap[key] = value
        })

        msftAuthSuccess = true
        if(queryMap.state !== oauthState) {
            ipcEvent.reply(
                MSFT_OPCODE.REPLY_LOGIN,
                MSFT_REPLY_TYPE.ERROR,
                MSFT_ERROR.OAUTH,
                msftAuthViewOnClose,
                'La reponse Microsoft est invalide (state OAuth incorrect). Reessaie la connexion.'
            )
        } else if(queryMap.error != null) {
            ipcEvent.reply(
                MSFT_OPCODE.REPLY_LOGIN,
                MSFT_REPLY_TYPE.ERROR,
                MSFT_ERROR.OAUTH,
                msftAuthViewOnClose,
                queryMap.error_description || queryMap.error
            )
        } else if(queryMap.code == null) {
            ipcEvent.reply(
                MSFT_OPCODE.REPLY_LOGIN,
                MSFT_REPLY_TYPE.ERROR,
                MSFT_ERROR.OAUTH,
                msftAuthViewOnClose,
                'Microsoft n a retourne aucun code d autorisation.'
            )
        } else {
            queryMap.code_verifier = codeVerifier
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)
        }

        msftAuthWindow?.close()
        msftAuthWindow = null
    }

    msftAuthWindow.webContents.on('will-redirect', (event, uri) => {
        if(uri.startsWith(MICROSOFT_REDIRECT_URI)) {
            event.preventDefault()
            handleMicrosoftRedirect(uri)
        }
    })
    msftAuthWindow.webContents.on('did-navigate', (_, uri) => handleMicrosoftRedirect(uri))

    msftAuthWindow.removeMenu()
    const authorizeUrl = new URL(MICROSOFT_AUTHORIZE_ENDPOINT)
    authorizeUrl.search = new URLSearchParams({
        client_id: AZURE_CLIENT_ID,
        response_type: 'code',
        redirect_uri: MICROSOFT_REDIRECT_URI,
        response_mode: 'query',
        scope: 'XboxLive.signin offline_access',
        prompt: 'select_account',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: oauthState
    }).toString()
    msftAuthWindow.loadURL(authorizeUrl.toString()).catch(err => {
        if(msftAuthSuccess) {
            return
        }
        msftAuthSuccess = true
        ipcEvent.reply(
            MSFT_OPCODE.REPLY_LOGIN,
            MSFT_REPLY_TYPE.ERROR,
            MSFT_ERROR.OAUTH,
            msftAuthViewOnClose,
            `Impossible d ouvrir la connexion Microsoft: ${err.message}`
        )
        msftAuthWindow?.close()
        msftAuthWindow = null
    })
})

// Microsoft Auth Logout
let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win

function createWindow() {

    win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1280,
        minHeight: 760,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())

    /*win.once('ready-to-show', () => {
        win.show()
    })*/

    win.removeMenu()

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        // Extend default included application menu to continue support for quit keyboard shortcut
        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        // New edit menu adds support for text-editing keyboard shortcuts
        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        // Bundle submenus into a single template and build a menu object with it
        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        // Assign it to the application
        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (win === null) {
        createWindow()
    }
})
