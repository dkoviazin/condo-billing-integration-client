const { gql } = require('graphql-tag')
const { generateGqlQueries } = require('../apollo-server-client')

const BILLING_INTEGRATION_ORGANIZATION_CONTEXT_FIELDS = `{ id integration { id name } organization { name tin } settings state status lastReport }`
const BillingContext = generateGqlQueries('BillingIntegrationOrganizationContext', BILLING_INTEGRATION_ORGANIZATION_CONTEXT_FIELDS)

const BILLING_RECEIPT_FIELDS = '{ id importId v updatedAt }'

const BillingReceipt = generateGqlQueries('BillingReceipt', BILLING_RECEIPT_FIELDS)

const BILLING_RECEIPT_FILE_FIELDS = `{ id v controlSum importId publicDataFile { originalFilename } }`
const BillingReceiptFile = generateGqlQueries('BillingReceiptFile', BILLING_RECEIPT_FILE_FIELDS)

const BILLING_RECIPIENT_FIELDS = '{ id bankAccount bic tin importId }'
const BillingRecipient =  generateGqlQueries('BillingRecipient', BILLING_RECIPIENT_FIELDS)


const REGISTER_BILLING_RECEIPTS_MUTATION = gql`
    mutation registerBillingReceipts ($data: RegisterBillingReceiptsInput!) {
        result: registerBillingReceipts(data: $data) ${BILLING_RECEIPT_FIELDS}
    }
`

module.exports = {
    BillingContext,
    BillingRecipient,
    BillingReceipt,
    BillingReceiptFile,
    REGISTER_BILLING_RECEIPTS_MUTATION,
}