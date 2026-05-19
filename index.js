const cliProgress = require('cli-progress')
const dayjs = require('dayjs')
const { Logger } = require('./integration/notify')
const { chunk } = require('lodash')
const { fetchWithRetry, bufferToStream, stream2buffer } = require('./apollo-server-client')

const {
    LOG_RECEIPTS_LOADED_MESSAGE,
    LOG_CONTEXT_MESSAGE,
    LOG_PERIOD_MESSAGE,
    LOG_PDF_RECEIPTS_COUNT_MESSAGE,
    LOG_CONDO_SAVE_MESSAGE,
    NOT_IMPLEMENTED_ERROR,
    FAILED_TO_GET_RECEIPTS_ERROR,
    PDF_SKIPP_MESSAGE,
} = require('./constants')

const { CondoBilling } = require('./integration/condoBilling')

const { endpoint, authRequisites, token } = process.env.CONDO_INTEGRATION ? JSON.parse(process.env.CONDO_INTEGRATION) : {}

const parseArguments = (args) => {
    const translates = { '--context': 'context', '-c': 'context', '--period': 'period', '-p': 'period' }
    return Object.fromEntries(
        chunk(args, 2)
            .map(([key, value]) => ([translates[key], value]))
            .filter(([key, value]) => Boolean(key) && value !== undefined)
    )
}

class Sync {
    constructor ({ integration, args, syncPeriodBefore = true, services = {} }) {
        const DEFAULT_PERIOD = dayjs().format('YYYY-MM-01')
        const { context: contextId, period = DEFAULT_PERIOD } = parseArguments(args)
        this.loggerFactory = services.loggerFactory || (() => new Logger())
        this.progressFactory = services.progressFactory || (() => new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic))
        this.condo = services.condo || new CondoBilling(endpoint, authRequisites)
        this.maxDepth = Number.isInteger(services.maxDepth) ? services.maxDepth : 6
        this.authToken = services.authToken !== undefined ? services.authToken : token

        this.integration = integration
        this.contextId = contextId
        this.syncPeriodBefore = syncPeriodBefore
        this.period = period
        this.organization = {}
    }

    async getReceiptsFromIntegration () {
        try {
            return await this.integration.getAllReceipts({ tin: this.organization.tin, period: this.period })
        } catch (error) {
            return { error }
        }
    }

    async sync () {
        const { name, tin } = this.organization
        const logger = this.loggerFactory()
        logger.addLog(`${name} (${tin})`)
        logger.addLog(LOG_CONTEXT_MESSAGE, this.contextId)
        logger.addLog(LOG_PERIOD_MESSAGE, this.period)
        logger.addSeparator()
        const { error, receipts = [] } = await this.getReceiptsFromIntegration()
        if (error) {
            logger.addLog('🔥 ' + error.toString())
            await logger.notify()
            throw new Error(FAILED_TO_GET_RECEIPTS_ERROR)
        }
        let time = logger.stopTimer()
        logger.addLog(`${LOG_RECEIPTS_LOADED_MESSAGE} (${receipts.length})`, time)
        logger.addSeparator()
        if (!receipts.length) {
            await logger.notify()
            return 0
        }
        const result = await this.condo.saveReceipts(this.contextId, receipts, this.period)
        time = logger.stopTimer()
        logger.addLog(LOG_CONDO_SAVE_MESSAGE, time)
        Object.entries(result).filter(([, value]) => value).forEach(([name, value]) => logger.addLog(name, value))
        const withFiles = receipts.filter(this.integration.hasPDFFile.bind(this.integration))
        logger.addSeparator()
        const progress = this.progressFactory()
        progress.start(withFiles.length)
        const pdfResult = {}
        for (const receipt of withFiles) {
            progress.increment(1)
            const isFileExisting = await this.condo.checkForFileExistence(this.contextId, receipt.importId)
            if (!isFileExisting) {
                const pdfBuffer = await this.integration.getPDFBuffer(receipt)
                const receiptResult = await this.condo.saveBillingReceiptFile(this.contextId, pdfBuffer, receipt)
                pdfResult[receiptResult] ||= 0
                pdfResult[receiptResult]++
            } else {
                pdfResult[PDF_SKIPP_MESSAGE] ||= 0
                pdfResult[PDF_SKIPP_MESSAGE]++
            }
        }
        progress.stop()
        time = logger.stopTimer()
        logger.addLog(LOG_PDF_RECEIPTS_COUNT_MESSAGE, time)
        Object.entries(pdfResult).filter(([, value]) => value).forEach(([name, value]) => logger.addLog(name, value))
        await logger.notify()
        return receipts.length
    }


    async init () {
        if (this.authToken) {
            this.condo.signInByToken(this.authToken)
        } else {
            await this.condo.signIn()
        }
        const contexts = await this.condo.getBillingContexts({ id: this.contextId })
        if (!contexts || !contexts.length) {
            throw new Error(`Billing context not found: ${this.contextId}`)
        }
        const [{ id, settings, organization: { name, tin } }] = contexts
        if (!id) {
            throw new Error(`Billing context id is empty: ${this.contextId}`)
        }
        const recipients = await this.condo.getBillingRecipients({
            context: { id },
        })
        this.integration.setCondoSettings({ settings, recipients })
        this.organization = { name, tin }
    }

    async run (){
        await this.init()
        try {
            let receiptsCount = await this.sync()
            if (receiptsCount === 0 && this.syncPeriodBefore) {
                let maxDepth = this.maxDepth
                while (--maxDepth > 0) {
                    this.period = dayjs(this.period, 'YYYY-MM-DD').add(-1, 'month').format('YYYY-MM-01')
                    receiptsCount = await this.sync()
                    if (receiptsCount) {
                        break
                    }
                }
            }
        } finally {
            await this.condo.signOut()
        }
    }

}

class Integration {

    /**
     * Retrieves all receipts from the integration.
     *
     * @async
     * @param {Object} { tin: String, period: String }
     * @returns {Promise<{ receipts: Array<Object> }>} An object containing an array of receipt objects.
     * @throws {Error} Throws an error if the method is not implemented.
     * @abstract
     */
    async getAllReceipts ({ tin, period }) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }

    /**
     * Sets condo settings for the integration.
     *
     * @param {Object} options - The options object.
     * @param {Object} options.settings - The condo settings object.
     * @param {Array<Object>} options.recipients - An array of recipient objects.
     * @returns {void}
     */
    setCondoSettings ({ settings, recipients }) {
        this.contextSettings = settings
        this.recipients = recipients
    }

    /**
     * Checks if a receipt has a PDF file.
     *
     * @param {Object} receipt - The receipt object.
     * @returns {boolean} Returns true if the receipt has a PDF file, otherwise false.
     * @throws {Error} Throws an error if the method is not overridden.
     * @abstract
     */
    hasPDFFile (receipt) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }


    /**
     * Retrieves the sensitive data stream for a given integration receipt.
     *
     * @async
     * @param {Object} receipt - The integration receipt object.
     * @returns {Promise<Buffer|null>} A stream representing the sensitive data, or null if no sensitive data is available.
     * @throws {Error} Throws an error if the method is not overridden.
     * @abstract
     */
    async getPDFBuffer (receipt) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }
}


module.exports = {
    fetchWithRetry,
    Sync,
    Integration,
    bufferToStream,
    stream2buffer,
    parseArguments,
}
