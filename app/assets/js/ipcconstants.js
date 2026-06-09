const packageConfig = require('../../../package.json')

exports.AZURE_CLIENT_ID = process.env.KHAERIS_MICROSOFT_CLIENT_ID
    || packageConfig.minecraftAuth?.microsoftClientId
    || ''
exports.MICROSOFT_REDIRECT_URI = 'https://login.microsoftonline.com/common/oauth2/nativeclient'


// Opcodes
exports.MSFT_OPCODE = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}
// Reply types for REPLY opcode.
exports.MSFT_REPLY_TYPE = {
    SUCCESS: 'MSFT_AUTH_REPLY_SUCCESS',
    ERROR: 'MSFT_AUTH_REPLY_ERROR'
}
// Error types for ERROR reply.
exports.MSFT_ERROR = {
    ALREADY_OPEN: 'MSFT_AUTH_ERR_ALREADY_OPEN',
    NOT_FINISHED: 'MSFT_AUTH_ERR_NOT_FINISHED',
    CONFIGURATION: 'MSFT_AUTH_ERR_CONFIGURATION',
    OAUTH: 'MSFT_AUTH_ERR_OAUTH'
}

exports.SHELL_OPCODE = {
    TRASH_ITEM: 'TRASH_ITEM'
}
