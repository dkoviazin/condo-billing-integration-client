const test = require('node:test')
const assert = require('node:assert/strict')

const { Sync, Integration, parseArguments } = require('./index')
const {
    NOT_IMPLEMENTED_ERROR,
    FAILED_TO_GET_RECEIPTS_ERROR,
} = require('./constants')

function createLogger() {
    return {
        entries: [],
        notified: false,
        addLog(name, value) {
            this.entries.push({ name, value })
        },
        addSeparator() {},
        stopTimer() {
            return '0.00 s'
        },
        async notify() {
            this.notified = true
        },
    }
}

function createProgress() {
    return {
        total: 0,
        current: 0,
        start(total) {
            this.total = total
        },
        increment(value = 1) {
            this.current += value
        },
        stop() {},
    }
}

test('parseArguments supports short and long flags', () => {
    assert.deepEqual(parseArguments(['-c', 'ctx', '-p', '2026-04-01']), {
        context: 'ctx',
        period: '2026-04-01',
    })

    assert.deepEqual(parseArguments(['--context', 'ctx-2', '--period', '2026-03-01']), {
        context: 'ctx-2',
        period: '2026-03-01',
    })
})

test('parseArguments ignores unknown or incomplete pairs', () => {
    assert.deepEqual(parseArguments(['--unknown', 'x', '-c']), {})
})

test('Integration base class methods are abstract', async () => {
    const integration = new Integration()

    await assert.rejects(integration.getAllReceipts({ tin: '1', period: '2026-01-01' }), new RegExp(NOT_IMPLEMENTED_ERROR))
    assert.throws(() => integration.hasPDFFile({}), new RegExp(NOT_IMPLEMENTED_ERROR))
    await assert.rejects(integration.getPDFBuffer({}), new RegExp(NOT_IMPLEMENTED_ERROR))
})

test('Sync retries previous months and signs out after successful run', async () => {
    const periods = []
    const condoCalls = {
        signOut: 0,
        saveReceipts: 0,
    }

    const condo = {
        signInByToken() {},
        async signIn() {},
        async getBillingContexts() {
            return [{
                id: 'ctx',
                settings: {},
                organization: { name: 'Org', tin: '123' },
            }]
        },
        async getBillingRecipients() {
            return []
        },
        async saveReceipts(_contextId, receipts) {
            condoCalls.saveReceipts += 1
            return {
                Created: receipts.length,
                Updated: 0,
                Errors: 0,
                Unchanged: 0,
            }
        },
        async saveBillingReceiptFile() {
            return 'Unchanged'
        },
        async signOut() {
            condoCalls.signOut += 1
        },
    }

    const integration = {
        setCondoSettings() {},
        async getAllReceipts({ period }) {
            periods.push(period)
            if (period === '2026-04-01') {
                return { receipts: [] }
            }
            return {
                receipts: [{
                    importId: '1',
                    accountNumber: '100',
                    address: 'A',
                    tin: '1',
                    bankAccount: '2',
                    routingNumber: '3',
                    year: 2026,
                    month: 3,
                    toPay: '10.00',
                }],
            }
        },
        hasPDFFile() {
            return false
        },
        async getPDFBuffer() {
            return null
        },
    }

    const logger = createLogger()
    const sync = new Sync({
        integration,
        args: ['-c', 'ctx', '-p', '2026-04-01'],
        syncPeriodBefore: true,
        services: {
            condo,
            authToken: 'token',
            maxDepth: 3,
            loggerFactory: () => logger,
            progressFactory: createProgress,
        },
    })

    await sync.run()

    assert.deepEqual(periods, ['2026-04-01', '2026-03-01'])
    assert.equal(condoCalls.saveReceipts, 1)
    assert.equal(condoCalls.signOut, 1)
})

test('Sync signs out even when integration fails', async () => {
    let signOutCalled = 0

    const condo = {
        signInByToken() {},
        async signIn() {},
        async getBillingContexts() {
            return [{
                id: 'ctx',
                settings: {},
                organization: { name: 'Org', tin: '123' },
            }]
        },
        async getBillingRecipients() {
            return []
        },
        async saveReceipts() {
            return {}
        },
        async saveBillingReceiptFile() {
            return 'Errors'
        },
        async signOut() {
            signOutCalled += 1
        },
    }

    const integration = {
        setCondoSettings() {},
        async getAllReceipts() {
            throw new Error('boom')
        },
        hasPDFFile() {
            return false
        },
        async getPDFBuffer() {
            return null
        },
    }

    const sync = new Sync({
        integration,
        args: ['-c', 'ctx', '-p', '2026-04-01'],
        services: {
            condo,
            authToken: 'token',
            loggerFactory: createLogger,
            progressFactory: createProgress,
        },
    })

    await assert.rejects(sync.run(), new RegExp(FAILED_TO_GET_RECEIPTS_ERROR))
    assert.equal(signOutCalled, 1)
})
