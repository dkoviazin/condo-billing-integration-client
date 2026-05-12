const test = require('node:test')
const assert = require('node:assert/strict')

const { CondoBilling } = require('./condoBilling')

function createSubject() {
    return Object.create(CondoBilling.prototype)
}

test('toMoney formats numeric values to 2 decimals', () => {
    const subject = createSubject()

    assert.equal(subject.toMoney(10), '10.00')
    assert.equal(subject.toMoney('3.456'), '3.46')
    assert.equal(subject.toMoney(null), '0.00')
})

test('toMoneyOrNull returns null for zero amount', () => {
    const subject = createSubject()

    assert.equal(subject.toMoneyOrNull(0), null)
    assert.equal(subject.toMoneyOrNull('0.00'), null)
    assert.equal(subject.toMoneyOrNull('1.01'), '1.01')
})

test('setTypesToToPayDetails normalizes money values and optional fields', () => {
    const subject = createSubject()

    const result = subject.setTypesToToPayDetails({
        charge: '10',
        balance: '0',
        penalty: 2,
        paid: 3,
        privilege: 0,
        recalculation: -1,
        volume: 7,
        tariff: 5.5,
    })

    assert.deepEqual(result, {
        formula: 'deprecated',
        balance: null,
        charge: '10.00',
        privilege: null,
        penalty: '2.00',
        paid: '3.00',
        recalculation: '-1.00',
        volume: '7',
        tariff: '5.5',
    })
})

test('setTypesToReceipt converts required fields and service lines', () => {
    const subject = createSubject()

    const receipt = subject.setTypesToReceipt({
        importId: 99,
        accountNumber: 1001,
        accountMeta: { id: 'meta' },
        address: 'Address',
        addressMeta: { id: 'ameta' },
        tin: 111,
        bankAccount: 222,
        routingNumber: 333,
        year: '2026',
        month: '4',
        toPay: 70,
        category: { id: 'cat' },
        toPayDetails: {
            charge: '40',
            balance: '20',
            penalty: '5',
            paid: '10',
            privilege: '0',
            recalculation: '-1',
        },
        services: [{
            id: 1,
            name: 'Water',
            toPay: '20',
            toPayDetails: {
                charge: '20',
                balance: 0,
                penalty: 0,
                paid: 0,
                privilege: 0,
                recalculation: 0,
            },
        }],
    })

    assert.equal(receipt.importId, '99')
    assert.equal(receipt.accountNumber, '1001')
    assert.equal(receipt.tin, '111')
    assert.equal(receipt.bankAccount, '222')
    assert.equal(receipt.routingNumber, '333')
    assert.equal(receipt.year, 2026)
    assert.equal(receipt.month, 4)
    assert.equal(receipt.toPay, '70.00')
    assert.equal(receipt.services.length, 1)
    assert.equal(receipt.services[0].id, '1')
    assert.equal(receipt.services[0].toPay, '20.00')
    assert.equal(receipt.services[0].toPayDetails.charge, '20.00')
})
