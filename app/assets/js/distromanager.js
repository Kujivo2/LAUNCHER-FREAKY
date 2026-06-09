const { HeliosDistribution } = require('helios-core/common')

const ConfigManager = require('./configmanager')
const SimpleModpackManager = require('./simplemodpackmanager')

/**
 * Minimal local distro facade.
 *
 * Helios UI helpers still expect DistroAPI during startup and in settings.
 * Gameplay now launches from the Khaeris local profile instead of downloading
 * a remote distribution.json.
 */
class SimpleDistroAPI {

    constructor() {
        this.commonDir = null
        this.instanceDir = null
        this.devMode = false
        this.distribution = null
    }

    createDistribution() {
        this.distribution = new HeliosDistribution(
            SimpleModpackManager.getBootstrapDistribution(),
            this.commonDir || ConfigManager.getCommonDirectory(),
            this.instanceDir || ConfigManager.getInstanceDirectory()
        )
        return this.distribution
    }

    async getDistribution() {
        return this.distribution || this.createDistribution()
    }

    async refreshDistributionOrFallback() {
        return this.createDistribution()
    }

    toggleDevMode(dev) {
        this.devMode = dev
    }

    isDevMode() {
        return this.devMode
    }
}

exports.REMOTE_DISTRO_URL = null
exports.DistroAPI = new SimpleDistroAPI()
