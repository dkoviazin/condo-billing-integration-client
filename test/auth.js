require('dotenv').config()

const { CondoBilling } = require('../integration/condoBilling')

const { endpoint, authRequisites } = process.env.CONDO_INTEGRATION ? JSON.parse(process.env.CONDO_INTEGRATION) : {}

const checkAuth = async () => {
    const client = new CondoBilling(endpoint, authRequisites)
    await client.signIn()
    console.log('SignIn: ', client.userId, client.authToken)
    const result = await client.signOut()
    console.log('SignOut: ', result)
}

checkAuth().then(() => {
    console.log('All done')
    process.exit(0)
}).catch(error => {
    console.error(error)
    process.exit(1)
})