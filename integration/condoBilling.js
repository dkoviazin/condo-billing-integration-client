const crypto = require('crypto')
const { ApolloServerClient } = require('../apollo-server-client')
const Big = require('big.js')
const { get, isEmpty, chunk} = require('lodash')
const { clearSensitiveData, bufferToStream } = require('../pdf/index.js')
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
    BillingReceipt: BillingReceiptGql,
    BillingContext: ContextGql,
    BillingRecipient,
    REGISTER_BILLING_RECEIPTS_MUTATION, BillingReceiptFix,
} = require('./condo.gql')
const {
    CONDO_SAVE_CHUNK_SIZE,
    DEFAULT_SAVE_RAW_DATA,
} = require('../constants')
const { stream2buffer } = require('../pdf')

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
        return await this.loadByChunks({
            modelGql: ContextGql,
            where: where,
        })
    }

    async updateContext (id, updateInput = {}) {
        return await this.updateModel({
            modelGql: ContextGql,
            id,
            updateInput,
        })
    }

    async processPDFFile (buffer, receipt) {
        const { accountMeta } = receipt
        return await clearSensitiveData(buffer,[get(accountMeta, 'fullName')])
    }

    async getPDFStreams (streams, receipt) {
        const { getPublicDataStream, getSensitiveDataStream } = streams
        const sensitiveStream = await getSensitiveDataStream(receipt)
        if (!sensitiveStream) {
            return {}
        }
        const sensitiveBuffer = await stream2buffer(sensitiveStream)
        const publicStream = await getPublicDataStream(receipt)
        const publicBuffer = publicStream ? await stream2buffer(publicStream) : await this.processPDFFile(sensitiveBuffer, receipt)
        const name = [receipt.accountNumber, receipt.year, receipt.month].join('_')
        return {
            ...sensitiveBuffer ? { sensitiveDataFile: this.createUploadFile({
                    stream: bufferToStream(sensitiveBuffer),
                    filename: `${name}.private.pdf`,
                    mimetype: 'application/pdf',
            }) } : {},
            ...publicBuffer ? { publicDataFile: this.createUploadFile({
                    stream: bufferToStream(publicBuffer),
                    filename: `${name}.public.pdf`,
                    mimetype: 'application/pdf',
                }) } : {},
        }
    }

    async saveBillingReceiptFile (streams, receipt) {
        const { contextId, importId, raw } = receipt
        const [existing] = await this.getModels({ modelGql: FileGql, where: {
            importId: String(importId),
            context: { id: contextId },
        }})
        const controlSum = createHash(JSON.stringify(raw))
        if (existing) {
            if (existing.controlSum !== controlSum) {
                try {
                    const files = await this.getPDFStreams(streams, receipt)
                    if (!isEmpty(files)) {
                        await this.updateModel({
                            modelGql: FileGql, id: existing.id,
                            updateInput: {
                                ...files,
                                controlSum,
                            },
                        })
                        return PDF_UPDATE_MESSAGE
                    } else {
                        return PDF_ERROR_MESSAGE
                    }
                } catch (error) {
                    console.error(error)
                    return PDF_ERROR_MESSAGE
                }
            } else {
                return PDF_SKIPP_MESSAGE
            }
        } else {
            try {
                const files = await this.getPDFStreams(streams, receipt)
                if (!isEmpty(files)) {
                    await this.createModel({
                        modelGql: FileGql,
                        createInput: {
                            importId: String(importId),
                            context: { connect: { id: contextId } },
                            ...files,
                            controlSum,
                        }
                    })
                    return PDF_CREATE_MESSAGE
                } else {
                    return PDF_ERROR_MESSAGE
                }
            } catch (error) {
                console.error(error)
                return PDF_ERROR_MESSAGE
            }
        }
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
        const { importId, accountNumber, accountMeta, address, addressMeta, tin, bankAccount, routingNumber, raw, year, month, services, toPay, toPayDetails, category } = receipt
        return {
            ...importId ? { importId: String(importId) } : {},
            accountNumber: String(accountNumber),
            accountMeta,
            address,
            addressMeta,
            tin: String(tin), bankAccount: String(bankAccount), routingNumber: String(routingNumber),
            raw,
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
                            receipts: chunk.map(({ raw, receipt}) => {
                                return {
                                    ...receipt,
                                    ...DEFAULT_SAVE_RAW_DATA ? { raw } : {},
                                }
                            }),
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