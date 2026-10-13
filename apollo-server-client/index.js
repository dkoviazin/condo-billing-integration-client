const { ApolloClient, InMemoryCache, ApolloLink } = require('@apollo/client')
const { BatchHttpLink } = require('@apollo/client/link/batch-http')
const { RetryLink } = require('@apollo/client/link/retry')
const { onError }  = require('apollo-link-error')
const { createUploadLink } = require('apollo-upload-client')
const FormData = require('form-data')
const { chunk: splitArray } = require('lodash')
const { generateGqlQueries } = require('./gql-generate')
const { fetchWithRetry } = require('./fetchWithRetry')
const { Duplex } = require('stream')


const { MAX_REQUESTS_IN_BATCH, MAX_MODIFY_OPERATIONS_IN_REQUEST, MAX_RETRIES_ON_NETWORK_ERROR, LOAD_CHUNK_SIZE } = require('./constants')
const { SIGNIN_BY_EMAIL_MUTATION, SIGNOUT_MUTATION, SIGNIN_BY_PHONE_AND_PASSWORD_MUTATION } = require('./lib/gql')

class UploadingFile {
    constructor ({ stream, filename, mimetype, encoding }) {
        this.stream = stream

        if (filename) {
            this.filename = filename
            // NOTE: Note local file adapter uses this, to determine file mimetype
            this.name = filename
        }
        if (mimetype) {
            this.mimetype = mimetype
        }
        if (encoding) {
            this.encoding = encoding
        }
    }

    createReadStream () {
        return this.stream
    }
}

const normalizeAuthRequisites = (requisites = {}) => {
    const { email, identity, password, secret, phone, token } = requisites
    return Object.fromEntries([
        ['email', email || identity],
        ['password', password || secret],
        ['phone', phone],
        ['token', token],
    ].filter(([, value]) => !!value))
}

class OIDCAuthClient {

    constructor (authToken) {
        this.authToken = authToken
        this.cookieJar = new Headers()
    }

    async oidcRequest (url) {
        const response = await fetchWithRetry(url, {
            headers: {
                ...this.authToken ? { authorization: `Bearer ${this.authToken}` } : {},
                cookie: [...this.cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
            },
            redirect: 'manual',
            credentials: 'same-origin',
        })
        if (response.status >= 400) {
            throw new Error(`OIDC request failed: ${response.status} ${response.statusText}`)
        }
        const newCookies = getSetCookie(response.headers)
        if (newCookies) {
            newCookies.forEach(cookie => {
                const [cookieValue] = cookie.split(';')
                const [name, value] = cookieValue.split('=')
                this.cookieJar.set(name, value)
            })
        }
        return {
            location: response.headers.get('location'),
            debug: await response.text(),
        }
    }

}

function getSetCookie (headers) {
    if (!headers) {
        return []
    }
    if (typeof headers.getSetCookie === 'function') {
        return headers.getSetCookie()
    }
    if (typeof headers.raw === 'function') {
        return headers.raw()['set-cookie'] || []
    }
    const singleCookie = headers.get('set-cookie')
    return singleCookie ? [singleCookie] : []
}

/**
 * A compact description of a model used to generate GraphQL operations.
 *
 * @typedef {Object} ModelGqlDescriptor
 * @property {string} name GraphQL model name, for example `BillingReceipt`.
 * @property {string} fields GraphQL selection set, for example `{ id amount }`.
 */

/**
 * Result of `generateGqlQueries`.
 *
 * @typedef {Object} GeneratedModelGql
 * @property {string} SINGULAR_FORM
 * @property {string} PLURAL_FORM
 * @property {string} MODEL_FIELDS
 * @property {import('graphql').DocumentNode} GET_ALL_OBJS_QUERY
 * @property {import('graphql').DocumentNode} GET_COUNT_OBJS_QUERY
 * @property {import('graphql').DocumentNode} GET_ALL_OBJS_WITH_COUNT_QUERY
 * @property {import('graphql').DocumentNode} CREATE_OBJ_MUTATION
 * @property {import('graphql').DocumentNode} CREATE_OBJS_MUTATION
 * @property {import('graphql').DocumentNode} UPDATE_OBJ_MUTATION
 * @property {import('graphql').DocumentNode} UPDATE_OBJS_MUTATION
 * @property {import('graphql').DocumentNode} DELETE_OBJ_MUTATION
 * @property {import('graphql').DocumentNode} DELETE_OBJS_MUTATION
 */

/**
 * Both the descriptor form and the object returned by `generateGqlQueries` are supported.
 *
 * @typedef {ModelGqlDescriptor|GeneratedModelGql} ModelGql
 */

class ApolloServerClient {
    #isAuthorized = false
    #modelGqlCache = new Map()
    client
    clientName
    authToken
    userId
    locale
    endpoint
    authRequisites = {}
    logger

    /**
     * @param {string} endpoint GraphQL endpoint.
     * @param {Object} [authRequisites]
     * @param {string} [authRequisites.identity] Email/identity for password authentication.
     * @param {string} [authRequisites.secret] Password for identity authentication.
     * @param {string} [authRequisites.phone] Phone for phone authentication.
     * @param {string} [authRequisites.password] Password for phone authentication.
     * @param {string} [authRequisites.token] Existing authentication token.
     * @param {Object} [options]
     * @param {string} [options.clientName='apollo-server-client'] Logger fingerprint.
     * @param {string} [options.locale='ru'] Server-side locale.
     */
    constructor (endpoint, authRequisites = {}, { clientName = 'apollo-server-client', locale = 'ru' } = {}) {
        this.clientName = clientName
        this.endpoint = endpoint
        this.locale = locale

        this.authRequisites = normalizeAuthRequisites(authRequisites)
        this.batchClient = this.createClient([this.errorLink(), this.authLink(), this.retryLink(), this.batchTerminateLink()])
        this.client = this.createClient([this.errorLink(), this.authLink(), this.retryLink(), this.uploadTerminateLink()])
    }

    dvSender () {
        return { dv: 1, sender: { dv: 1, fingerprint: this.clientName } }
    }

    createClient (links) {
        return new ApolloClient({
            link: ApolloLink.from(links),
            cache: new InMemoryCache({ addTypename: false }),
            defaultOptions: {
                watchQuery: {
                    fetchPolicy: 'no-cache',
                },
                query: {
                    fetchPolicy: 'no-cache',
                },
            },
        })
    }

    #resolveModelGql (modelGql) {
        if (modelGql === null || typeof modelGql !== 'object') {
            throw new TypeError('modelGql must be a generated GraphQL model or a descriptor { name, fields }')
        }

        const hasName = Object.hasOwn(modelGql, 'name')
        const hasFields = Object.hasOwn(modelGql, 'fields')

        if (!hasName && !hasFields) {
            const requiredQueries = [
                'GET_ALL_OBJS_QUERY',
                'GET_COUNT_OBJS_QUERY',
                'CREATE_OBJ_MUTATION',
                'UPDATE_OBJ_MUTATION',
                'CREATE_OBJS_MUTATION',
                'UPDATE_OBJS_MUTATION',
            ]
            if (!requiredQueries.every(queryName => modelGql[queryName])) {
                throw new TypeError('modelGql must contain generated GraphQL queries')
            }
            return modelGql
        }

        if (!hasName || !hasFields || typeof modelGql.name !== 'string' || typeof modelGql.fields !== 'string') {
            throw new TypeError('modelGql descriptor must contain string properties name and fields')
        }

        const name = modelGql.name.trim()
        const fields = modelGql.fields.trim()
        const cacheKey = `${name}\u0000${fields}`

        if (!this.#modelGqlCache.has(cacheKey)) {
            this.#modelGqlCache.set(cacheKey, generateGqlQueries(name, fields))
        }

        return this.#modelGqlCache.get(cacheKey)
    }

    async signIn () {
        if (Reflect.has(this.authRequisites, 'token')) {
            this.signInByToken(this.authRequisites.token)
            return
        }
        if (Reflect.has(this.authRequisites, 'phone')) {
            await this.singInByPhoneAndPassword()
        } else {
            await this.singInByEmailAndPassword()
        }
    }

    async signOut () {
        if (Reflect.has(this.authRequisites, 'token')) {
            // do not destroy token
            return
        }
        const { data: { unauthenticateUser: { success } } } = await this.client.mutate({
            mutation: SIGNOUT_MUTATION,
        })
        if (success) {
            this.#isAuthorized = false
            this.authToken = null
            this.userId = null
        }
        return success
    }

    /**
    * @example
    * const client = new ApolloServerClient(`${CONDO_URL}/admin/api`, { phone:'***', password: '***' })
    * await client.signIn()
    * const miniAppClient = await client.signInToMiniApp(`${REGISTRY_URL}/graphql`)
    */
    async signInToMiniApp (apiEndpoint) {
        if (!this.authToken) {
            throw new Error('You need to authorize on condo first')
        }
        const miniAppAuth = new OIDCAuthClient()
        const condoAuth = new OIDCAuthClient(this.authToken)
        const { origin } = new URL(apiEndpoint)
        // Start auth
        const { location: startAuthUrl } = await miniAppAuth.oidcRequest(`${origin}/oidc/auth`)
        // Condo redirects
        const { location: interactUrl } = await condoAuth.oidcRequest(startAuthUrl)
        const { location: interactCompleteUrl } = await condoAuth.oidcRequest(interactUrl)
        const { location: completeAuthUrl } = await condoAuth.oidcRequest(interactCompleteUrl)
        // Complete auth
        await miniAppAuth.oidcRequest(completeAuthUrl)
        const decodedToken = decodeURIComponent(miniAppAuth.cookieJar.get('keystone.sid'))

        const miniAppClient = new ApolloServerClient(apiEndpoint, this.authRequisites)
        miniAppClient.signInByToken(decodedToken.split('s:')[1])
        return miniAppClient
    }

    signInByToken (token) {
        this.authToken = token
        this.#isAuthorized = true
    }

    async singInByEmailAndPassword () {
        const { email, password } = this.authRequisites
        const { data: { auth: { user, token } } } = await this.client.mutate({
            mutation: SIGNIN_BY_EMAIL_MUTATION,
            variables: {
                identity: email,
                secret: password,
            },
        })
        this.userId = user.id
        this.authToken = token
        this.#isAuthorized = true
    }

    async singInByPhoneAndPassword () {
        const { phone,  password } = this.authRequisites
        const { data: { obj: { item: user, token } } } = await this.client.mutate({
            mutation: SIGNIN_BY_PHONE_AND_PASSWORD_MUTATION,
            variables: { ...this.dvSender(), phone, password },
        })
        this.userId = user.id
        this.authToken = token
        this.#isAuthorized = true
    }

    async executeAuthorizedQuery (queryArgs, opts = { batchClient: false }) {
        if (!this.#isAuthorized) {
            await this.signIn()
        }

        if (opts.batchClient) {
            return this.batchClient.query(queryArgs)
        } else {
            return this.client.query(queryArgs)
        }
    }

    async executeAuthorizedMutation (mutationArgs, opts = { batchClient: false }) {
        if (!this.#isAuthorized) {
            await this.signIn()
        }

        if (opts.batchClient) {
            return this.batchClient.mutate(mutationArgs)
        } else {
            return this.client.mutate(mutationArgs)
        }
    }

    /**
     * Loads all matching objects by several requests.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object} [options.where] GraphQL `where` filter.
     * @param {number} [options.chunkSize=LOAD_CHUNK_SIZE] Number of objects per request.
     * @param {number} [options.limit=100000] Maximum number of objects to load.
     * @param {string[]} [options.sortBy=['id_ASC']] Sorting rules.
     * @returns {Promise<Object[]>}
     *
     * @example
     * const receipts = await client.loadByChunks({
     *     modelGql: { name: 'BillingReceipt', fields: '{ id toPay }' },
     *     where: { account: { id: { eq: accountId } } },
     * })
     */
    async loadByChunks ({ modelGql, where, chunkSize = LOAD_CHUNK_SIZE, limit = 100000, sortBy = ['id_ASC'] }) {
        if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
            throw new RangeError('chunkSize must be a positive integer')
        }

        if (!Number.isInteger(limit) || limit < 0) {
            throw new RangeError('limit must be a non-negative integer')
        }

        let skip = 0
        const all = []

        while (all.length < limit) {
            const first = Math.min(chunkSize, limit - all.length)
            const chunk = await this.getModels({ modelGql, where, sortBy, first, skip })

            if (!chunk.length) {
                break
            }

            all.push(...chunk)
            skip += chunk.length

            if (chunk.length < first) {
                break
            }
        }

        return all
    }

    /**
     * Counts objects matching a filter.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object} [options.where] GraphQL `where` filter.
     * @param {number} [options.first] Optional pagination argument accepted by the API.
     * @param {number} [options.skip] Optional pagination argument accepted by the API.
     * @param {string[]} [options.sortBy] Optional sorting rules.
     * @returns {Promise<number>}
     *
     * @example
     * const count = await client.getCount({
     *     modelGql: { name: 'BillingReceipt', fields: '{ id }' },
     *     where: { account: { id: { eq: accountId } } },
     * })
     */
    async getCount ({ modelGql, where, first, skip, sortBy }) {
        const queries = this.#resolveModelGql(modelGql)
        const { data: { meta: { count } } } = await this.executeAuthorizedQuery({
            query: queries.GET_COUNT_OBJS_QUERY,
            variables: {
                where,
                first,
                skip,
                sortBy,
            },
        })
        return count
    }

    /**
     * Loads one page of objects. The API default page size is 100.
     * Use `loadByChunks` when all matching objects are required.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object} [options.where] GraphQL `where` filter.
     * @param {number} [options.first] Page size.
     * @param {number} [options.skip] Number of objects to skip.
     * @param {string[]} [options.sortBy] Sorting rules.
     * @returns {Promise<Object[]>}
     *
     * @example
     * const receipts = await client.getModels({
     *     modelGql: { name: 'BillingReceipt', fields: '{ id amount }' },
     *     first: 50,
     *     sortBy: ['createdAt_DESC'],
     * })
     */
    async getModels ({ modelGql, where, first, skip, sortBy }) {
        const queries = this.#resolveModelGql(modelGql)
        const { data: { objs } } = await this.executeAuthorizedQuery({
            query: queries.GET_ALL_OBJS_QUERY,
            variables: {
                where,
                first,
                skip,
                sortBy,
            },
        })
        return objs
    }

    /**
     * Updates one object.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {string} [options.id] Object identifier.
     * @param {Object} options.updateInput Fields accepted by the model update input.
     * @returns {Promise<Object>}
     *
     * @example
     * const receipt = await client.updateModel({
     *     modelGql: { name: 'BillingReceipt', fields: '{ id status }' },
     *     id: receiptId,
     *     updateInput: { status: 'PAID' },
     * })
     */
    async updateModel ({ modelGql, id = null, updateInput }) {
        const queries = this.#resolveModelGql(modelGql)
        const variables = { data: { ...this.dvSender(), ...updateInput } }

        if (id) variables.id = id

        const { data: { obj: updatedObj, result: updatedResult } } = await this.executeAuthorizedMutation({
            mutation: queries.UPDATE_OBJ_MUTATION,
            variables,
        })

        return updatedObj || updatedResult
    }

    /**
     * Updates multiple objects in chunks.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object[]} [options.updateInputs=[]] Items in `{ id, data }` format.
     * @param {boolean} [options.isBatch=false] Use the batch GraphQL client.
     * @param {(processed: number) => (void|Promise<void>)} [options.onProgress]
     * @returns {Promise<Object[]>}
     */
    async updateModels ({ modelGql, updateInputs = [], isBatch = false, onProgress = () => null }) {
        const queries = this.#resolveModelGql(modelGql)
        const chunks = splitArray(updateInputs, MAX_MODIFY_OPERATIONS_IN_REQUEST)
        let result = []
        for (const chunk of chunks) {
            const { data: { objs } } = await this.executeAuthorizedMutation({
                mutation: queries.UPDATE_OBJS_MUTATION,
                variables: {
                    data: chunk.map(data => ({ id: data.id, data: { ...this.dvSender(), ...data.data } })),
                },
            }, { batchClient: isBatch })
            await onProgress(objs.length)
            result = result.concat(objs)
        }

        return result
    }

    /**
     * Creates one object.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object} options.createInput Fields accepted by the model create input.
     * @param {boolean} [options.isBatch=false] Use the batch GraphQL client.
     * @returns {Promise<Object>}
     *
     * @example
     * const receipt = await client.createModel({
     *     modelGql: { name: 'BillingReceipt', fields: '{ id accountNumber }' },
     *     createInput: { accountNumber, amount: 1250 },
     * })
     */
    async createModel ({ modelGql, createInput, isBatch = false }) {
        const queries = this.#resolveModelGql(modelGql)
        const { data: { obj } } = await this.executeAuthorizedMutation({
            mutation: queries.CREATE_OBJ_MUTATION,
            variables: {
                data: {
                    ...this.dvSender(),
                    ...createInput,
                },
            },
        }, { batchClient: isBatch })
        return obj
    }

    /**
     * Creates multiple objects in chunks.
     *
     * @param {Object} options
     * @param {ModelGql} options.modelGql Model descriptor or generated GraphQL object.
     * @param {Object[]} [options.createInputs=[]] Objects to create.
     * @param {boolean} [options.isBatch=false] Use the batch GraphQL client.
     * @param {(processed: number) => (void|Promise<void>)} [options.onProgress]
     * @returns {Promise<Object[]>}
     */
    async createModels ({ modelGql, createInputs = [], isBatch = false, onProgress = () => null }) {
        const queries = this.#resolveModelGql(modelGql)
        const chunks = splitArray(createInputs, MAX_MODIFY_OPERATIONS_IN_REQUEST)
        let result = []
        for (const chunk of chunks) {
            const { data: { objs } } = await this.executeAuthorizedMutation({
                mutation: queries.CREATE_OBJS_MUTATION,
                variables: {
                    data: chunk.map(data => ({ data: { ...this.dvSender(), ...data } })),
                },
            }, { batchClient: isBatch })
            await onProgress(objs.length)
            result = result.concat(objs)
        }
        return result
    }

    errorLink () {
        return onError(({ graphQLErrors, networkError, operation }) => {
            if (graphQLErrors)
                graphQLErrors.map(({ message, path }) =>
                    this.error('GraphQL error', { operation: operation.operationName, message, path }),
                )
            if (networkError) {
                this.error('Network error', { networkError })
            }
        })
    }

    authLink () {
        return new ApolloLink((operation, forward) => {
            operation.setContext({
                headers: {
                    authorization: 'Bearer ' + this.authToken,
                    'accept-language': this.locale,
                },
                credentials: 'same-origin',
            })
            return forward(operation)
        })
    }

    retryLink () {
        return new RetryLink({
            delay: { initial: 300, max: Infinity, jitter: true },
            attempts: {
                max: MAX_RETRIES_ON_NETWORK_ERROR,
                retryIf: (error, _operation) => {
                    this.info('Retry', { error, _operation })
                    return !!error
                },
            },
        })
    }

    createUploadFile ({ stream, buffer, filename, mimetype, encoding }) {
        stream ||= bufferToStream(buffer)
        return new UploadingFile({ stream, filename, mimetype, encoding })
    }

    uploadTerminateLink () {
        return createUploadLink({
            uri: this.endpoint,
            includeExtensions: true,
            isExtractableFile: (value) => {
                return value instanceof UploadingFile
            },
            FormData,
            formDataAppendFile: (form, name, file) => {
                if (file.name) {
                    form.append(name, file.stream, file.name)
                } else {
                    form.append(name, file.stream)
                }
            },
            fetch: fetchWithRetry,
        })
    }

    batchTerminateLink () {
        return new BatchHttpLink({
            uri: this.endpoint,
            batchMax: MAX_REQUESTS_IN_BATCH, // No more than ... operations per batch
            batchInterval: 20,
        })
    }

    error (message, payload = {}) {
        console.error({
            msg: message,
            payload,
        })
    }

    info (message, payload = {}) {
        console.info({
            msg: message,
            payload,
        })
    }
}


function bufferToStream (content) {
    const tmp = new Duplex()
    tmp.push(content)
    tmp.push(null)
    return tmp
}

async function stream2buffer (stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}


module.exports = {
    ApolloServerClient,
    generateGqlQueries,
    fetchWithRetry,
    bufferToStream,
    stream2buffer,
}
