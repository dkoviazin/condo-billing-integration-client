const crypto = require('crypto')
const { ApolloServerClient } = require('../apollo-server-client')
const Big = require('big.js')
const { get, isEmpty, chunk} = require('lodash')
const {
    PDF_CREATE_MESSAGE,
    PDF_UPDATE_MESSAGE,
    PDF_SKIPP_MESSAGE,
    PDF_ERROR_MESSAGE,
    LOG_CONDO_UPDATED_RECEIPTS_COUNT_MESSAGE,
    LOG_CONDO_CREATED_RECEIPTS_COUNT_MESSAGE,
    LOG_CONDO_ERROR_RECEIPTS_COUNT_MESSAGE,
    LOG_CONDO_UNTOUCHED_RECEIPTS_COUNT_MESSAGE,
} = require('../constants')
const dayjs = require('dayjs')

const {
    BillingReceiptFile: FileGql,
    BillingContext: ContextGql,
    BillingRecipient,
    REGISTER_BILLING_RECEIPTS_MUTATION,
    REGISTER_BILLING_RECEIPT_FILE_MUTATION,
} = require('./condo.gql')
const {
    CONDO_SAVE_CHUNK_SIZE,
} = require('../constants')

const createHash = (input) => crypto.createHash('md5').update(input).digest('hex')

class CondoBilling extends ApolloServerClient {

    async getBillingRecipients (where) {
        return (await this.loadByChunks({
            modelGql: BillingRecipient,
            where: {
                ...where,
            }
        })).filter(({ isApproved }) => isApproved === true).map(({ bic, ...recipient }) => ({ ...recipient, routingNumber: bic }))
    }

    async getBillingContexts (where = {}) {
        return this.loadByChunks({
            modelGql: ContextGql,
            where: where,
        })
    }

    async saveBillingReceiptFile (contextId, pdfBuffer, receipt) {
        if (!pdfBuffer) {
            return PDF_ERROR_MESSAGE
        }
        const [existing] = await this.getModels({
            modelGql: FileGql,
            where: {
                importId: String(receipt.importId),
                context: { id: contextId },
            }
        })
        const base64EncodedPDF = Buffer.from(pdfBuffer).toString('base64')
        const controlSum = createHash(base64EncodedPDF)
        if (!existing || existing.controlSum !== controlSum) {
            try {
                await this.client.mutate({
                    mutation: REGISTER_BILLING_RECEIPT_FILE_MUTATION,
                    variables: {
                        data: {
                            ...this.dvSender(),
                            context: { id: contextId },
                            receipt: { importId: String(receipt.importId) },
                            base64EncodedPDF,
                        },
                    },
                })
                return !existing ? PDF_CREATE_MESSAGE : PDF_UPDATE_MESSAGE
            } catch (error) {
                return PDF_ERROR_MESSAGE
            }
        }
        return PDF_SKIPP_MESSAGE
    }

    toMoney (value) {
        return Big(value || 0).toFixed(2)
    }

    toMoneyOrNull (value) {
        const money = this.toMoney(value)
        return money === '0.00' ? null : money
    }

    setTypesToToPayDetails (toPayDetails) {
        const {  charge, balance, penalty, paid, privilege, recalculation, volume, tariff } = toPayDetails
        return {
            formula: 'deprecated',
            balance: this.toMoneyOrNull(balance),
            charge: this.toMoneyOrNull(charge),
            privilege: this.toMoneyOrNull(privilege),
            penalty: this.toMoneyOrNull(penalty),
            paid: this.toMoneyOrNull(paid),
            recalculation: this.toMoneyOrNull(recalculation),
            ...volume ? { volume: String(volume) } : {},
            ...tariff ? { tariff: String(tariff) } : {},
        }
    }

    setTypesToReceipt (receipt) {
        const { importId, accountNumber, accountMeta, address, addressMeta, tin, bankAccount, routingNumber, year, month, services, toPay, toPayDetails, category } = receipt
        return {
            ...importId ? { importId: String(importId) } : {},
            accountNumber: String(accountNumber),
            accountMeta,
            address,
            addressMeta,
            tin: String(tin), bankAccount: String(bankAccount), routingNumber: String(routingNumber),
            ...category ? { category } : {},
            year: Number(year), month: Number(month),
            toPay: this.toMoney(toPay),
            ...toPayDetails ? { toPayDetails: this.setTypesToToPayDetails(toPayDetails) } : {},
            ...services && services.length ? { services: services.map(({ id, name, toPay, toPayDetails }) => ({
                id: String(id),
                name: name || '-',
                toPay: this.toMoney(toPay),
                ...toPayDetails ? { toPayDetails: this.setTypesToToPayDetails(toPayDetails) } : {},
            })) } : {}
        }
    }

    async saveReceipts (contextId, receipts = []) {
        const receiptWithTypes = receipts.map(this.setTypesToReceipt.bind(this))
        const chunks = chunk(receiptWithTypes, CONDO_SAVE_CHUNK_SIZE)
        const result = {
            [LOG_CONDO_CREATED_RECEIPTS_COUNT_MESSAGE]: 0,
            [LOG_CONDO_UPDATED_RECEIPTS_COUNT_MESSAGE]: 0,
            [LOG_CONDO_ERROR_RECEIPTS_COUNT_MESSAGE]: 0,
            [LOG_CONDO_UNTOUCHED_RECEIPTS_COUNT_MESSAGE]: 0,
        }
        for (const chunk of chunks) {
           try {
                const { data: { result: chunkResult }} = await this.client.mutate({
                    mutation: REGISTER_BILLING_RECEIPTS_MUTATION,
                    variables: {
                        data: {
                            ...this.dvSender(),
                            context: { id: contextId },
                            receipts: chunk,
                        },
                    },
                })
                chunkResult.forEach(idOrError => {
                    if (!get(idOrError, 'id')) {
                        result[LOG_CONDO_ERROR_RECEIPTS_COUNT_MESSAGE]++
                    } else {
                        const isUpdatedToday = dayjs(get(idOrError, 'updatedAt')).format('YYYY-MM-DD') === dayjs().format('YYYY-MM-DD')
                        if (isUpdatedToday) {
                            if (idOrError.v === 1) {
                                result[LOG_CONDO_CREATED_RECEIPTS_COUNT_MESSAGE]++
                            } else {
                                result[LOG_CONDO_UPDATED_RECEIPTS_COUNT_MESSAGE]++
                            }
                        } else {
                            result[LOG_CONDO_UNTOUCHED_RECEIPTS_COUNT_MESSAGE]++
                        }
                    }
                })
            } catch (err) {
                console.log('Error on saving to Condo', err)
            }
        }
        return result
    }

}

module.exports = {
    CondoBilling,
}
