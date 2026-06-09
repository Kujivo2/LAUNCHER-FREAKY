const DEFAULT_PUBLIC_BASE_URL = 'http://localhost/khaeris'

function trimTrailingSlashes(value) {
    return String(value).replace(/\/+$/, '')
}

const publicBaseUrl = trimTrailingSlashes(
    process.env.KHAERIS_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL
)

exports.PUBLIC_BASE_URL = publicBaseUrl
exports.MANIFEST_URL = process.env.KHAERIS_MANIFEST_URL || `${publicBaseUrl}/manifest.json`
exports.NEWS_URL = process.env.KHAERIS_NEWS_URL || `${publicBaseUrl}/news.json`
exports.LAUNCHER_UPDATE_URL = process.env.KHAERIS_LAUNCHER_UPDATE_URL || `${publicBaseUrl}/launcher`
