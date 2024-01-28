const cliProgress = require('cli-progress')
const dayjs = require('dayjs')
const { Logger } = require('./integration/notify')
const { chunk } = require('lodash')

const {
    LOG_RECEIPTS_LOADED_MESSAGE,
    LOG_CONTEXT_MESSAGE,
    LOG_PERIOD_MESSAGE,
    LOG_PDF_RECEIPTS_COUNT_MESSAGE,
    LOG_CONDO_SAVE_MESSAGE,
} = require('./constants')

const { CondoBilling } = require('./integration/condoBilling')

const { endpoint, authRequisites } = process.env.CONDO_INTEGRATION ? JSON.parse(process.env.CONDO_INTEGRATION) : {}

const parseArguments = (args) => {
    const translates = { '--context': 'context', '-c': 'context', '--period': 'period', '-p': 'period' }
    return Object.fromEntries(chunk(args, 2).map(([key, value]) => ([translates[key], value])))
}

class Sync {
    constructor({ integration, args, syncPeriodBefore = true }) {
        const DEFAULT_PERIOD = dayjs().format('YYYY-MM-01')
        const { context: contextId, period = DEFAULT_PERIOD } = parseArguments(args)
        this.period = period
        this.integration = integration
        this.contextId = contextId
        this.syncPeriodBefore = syncPeriodBefore
        this.period = period
        this.organization = {}
        this.condo = new CondoBilling(endpoint, authRequisites)
    }

    async getReceiptsFromIntegration () {
        try {
            const { receipts } = await this.integration.getAllReceipts({ tin: this.organization.tin, period: this.period })
            return { receipts }
        } catch (error) {
            return { error }
        }
    }

    async sync () {
        const { name, tin } = this.organization
        const logger = new Logger()
        logger.addLog(`${name} (${tin})`)
        logger.addLog(LOG_CONTEXT_MESSAGE, this.contextId)
        logger.addLog(LOG_PERIOD_MESSAGE, this.period)
        logger.addSeparator()
        const { error, receipts } = await this.getReceiptsFromIntegration()
        if (error) {
            logger.addLog('🔥 ' + error.toString())
            await logger.notify()
            throw new Error('FAILED TO GET RECEIPTS FROM INTEGRATION')
        }
        let time = logger.stopTimer()
        logger.addLog(`${LOG_RECEIPTS_LOADED_MESSAGE} (${receipts.length})`, time)
        logger.addSeparator()
        if (!receipts.length) {
            return 0
        }
        const result = await this.condo.saveReceipts(this.contextId, receipts, this.period)
        time = logger.stopTimer()
        logger.addLog(LOG_CONDO_SAVE_MESSAGE, time)
        Object.entries(result).filter(([value]) => value).map(([name, value]) => logger.addLog(name, value))
        const withFiles = receipts.filter(this.integration.hasPDFFile.bind(this.integration))
        logger.addSeparator()
        const progress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
        progress.start(withFiles.length)
        const pdfResult = {}
        for (const { importId, accountMeta, accountNumber, raw } of withFiles) {
            const receiptResult = await this.condo.saveBillingReceiptFile({
                getPublicDataStream: this.integration.getPublicFilePDFStream.bind(this.integration),
                getSensitiveDataStream: this.integration.getSensitiveFilePDFStream.bind(this.integration),
            }, { contextId: this.contextId, importId, raw, accountMeta, accountNumber, period: this.period })
            if (!pdfResult[receiptResult]) {
                pdfResult[receiptResult] = 0
            }
            progress.increment(1)
            pdfResult[receiptResult]++
        }
        progress.stop()
        time = logger.stopTimer()
        logger.addLog(LOG_PDF_RECEIPTS_COUNT_MESSAGE, time)
        Object.entries(pdfResult).filter(([value]) => value).map(([name, value]) => logger.addLog(name, value))
        await this.condo.updateContext(this.contextId, {
            lastReport: { period: this.period, finishTime: new Date().toISOString(), totalReceipts: receipts.length }
        })
        await logger.notify()
        return receipts.length
    }


    async init () {
        await this.condo.signIn()
        const [{ id, settings, organization: { name, tin } }] = await this.condo.getBillingContexts({ id: this.contextId })
        if (!id) {
            // Error
        }
        const recipients = await this.condo.getBillingRecipients({
            context: { id },
        })
        this.integration.setCondoSettings({ settings, recipients })
        this.organization = { name, tin }
    }

    async run (){
        await this.init()
        let receiptsCount = await this.sync()
        if (receiptsCount === 0 && this.syncPeriodBefore) {
            this.period = dayjs(this.period, 'YYYY-MM-DD').add(-1, 'month').format('YYYY-MM-01')
            await this.sync()
        }
        await this.condo.signOut()
    }

}

const NOT_IMPLEMENTED_ERROR = 'Not implemented'

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
     * Retrieves the public file PDF stream for a given integration receipt.
     *
     * @async
     * @param {Object} receipt - The integration receipt object.
     * @returns {Promise<Stream|null>} A stream representing the public file PDF.
     * @throws {Error} Throws an error if the method is not overridden or if no public version is available.
     * @abstract
     */
    async getPublicFilePDFStream (receipt) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }

    /**
     * Retrieves the sensitive data stream for a given integration receipt.
     *
     * @async
     * @param {Object} receipt - The integration receipt object.
     * @returns {Promise<Stream|null>} A stream representing the sensitive data, or null if no sensitive data is available.
     * @throws {Error} Throws an error if the method is not overridden.
     * @abstract
     */
    async getSensitiveDataStream (receipt) {
        throw new Error(NOT_IMPLEMENTED_ERROR)
    }
}

module.exports = {
    Sync,
    Integration,
}