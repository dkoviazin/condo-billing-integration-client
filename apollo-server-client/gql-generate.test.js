const test = require('node:test')
const assert = require('node:assert/strict')

const { generateGqlQueries } = require('./gql-generate')
const { ApolloServerClient } = require('./index')

test('generates queries from a model descriptor', async () => {
    const client = new ApolloServerClient('https://example.com/graphql')
    const requests = []
    client.executeAuthorizedQuery = async (request) => {
        requests.push(request)
        return { data: { objs: [{ id: '1' }] } }
    }

    const descriptor = { name: 'BillingReceipt', fields: '{ id }' }
    assert.deepEqual(await client.getModels({ modelGql: descriptor }), [{ id: '1' }])
    assert.deepEqual(await client.getModels({ modelGql: descriptor }), [{ id: '1' }])
    assert.equal(requests[0].query, requests[1].query)
})

test('rejects invalid model descriptors with a useful error', async () => {
    const client = new ApolloServerClient('https://example.com/graphql')

    await assert.rejects(
        client.getModels({ modelGql: null }),
        { name: 'TypeError', message: /modelGql must be a generated GraphQL model/ },
    )
    await assert.rejects(
        client.getModels({ modelGql: { name: 'BillingReceipt' } }),
        { name: 'TypeError', message: /descriptor must contain string properties/ },
    )
})

test('rejects invalid model names and selection sets', () => {
    assert.throws(
        () => generateGqlQueries('Billing-Receipt', '{ id }'),
        { name: 'TypeError', message: /valid GraphQL name/ },
    )
    assert.throws(
        () => generateGqlQueries('billingReceipt', '{ id }'),
        { name: 'TypeError', message: /valid GraphQL name/ },
    )
    assert.throws(
        () => generateGqlQueries('BillingReceipt2', '{ id }'),
        { name: 'TypeError', message: /valid GraphQL name/ },
    )
    assert.throws(
        () => generateGqlQueries('BillingReceipt', '{}'),
        { message: /wrong model fields selection set/ },
    )
})

test('loadByChunks respects limit and stops on a short page', async () => {
    const client = new ApolloServerClient('https://example.com/graphql')
    const calls = []
    const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }]]
    client.getModels = async (options) => {
        calls.push(options)
        return pages.shift() || []
    }

    const result = await client.loadByChunks({
        modelGql: { name: 'BillingReceipt', fields: '{ id }' },
        chunkSize: 2,
        limit: 3,
    })

    assert.deepEqual(result, [{ id: 1 }, { id: 2 }, { id: 3 }])
    assert.deepEqual(calls.map(({ first, skip }) => ({ first, skip })), [
        { first: 2, skip: 0 },
        { first: 1, skip: 2 },
    ])
})
