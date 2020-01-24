const functions = require('firebase-functions').region('asia-northeast1')
const kintoneJSSDK = require('@kintone/kintone-js-sdk')
const Mustache = require('mustache')
const config = require('./config.json')
require('dotenv').config()
const admin = require('firebase-admin')
const sgMail = require('@sendgrid/mail')
const mailer = require('nodemailer')

// const fillTemplateOriginal = (templateRecord, requestBody) => {
//   const view = Object.entries(requestBody.record).reduce(
//     (acc, [key, value]) => ({ ...acc, [key]: value.value }),
//     {}
//   )
//   return Object.entries(templateRecord).reduce((acc, [key, value]) => {
//     return typeof value.value === 'string'
//       ? {
//           ...acc,
//           [key]: Mustache.render(value.value, view),
//         }
//       : acc
//   }, {})
// }
const fillTemplate = (templateRecord, record) => {
  const view = Object.entries(record).reduce(
    (acc, [key, value]) => ({ ...acc, [key]: value.value }),
    {}
  )
  return Object.entries(templateRecord).reduce((acc, [key, value]) => {
    return typeof value.value === 'string'
      ? {
          ...acc,
          [key]: Mustache.render(value.value, view),
        }
      : acc
  }, {})
}

const composeMail = (record, templates) => {
  const templateRecord = templates.find(
    template =>
      template.mallName.value === record.mallName.value &&
      template.localGovernment.value === record.localGovernment.value
  )
  return fillTemplate(templateRecord, record)
}

const sendMailWithSg = async msg => {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY)
  sgMail.send(msg)
}

const sendMailToSmtp = async (smtpName, msg) => {
  const smtpOptions = config.smtpServers.find(server => server.name === smtpName)
  if (!smtpOptions) throw new Error('No SMTP config')
  const transporter = mailer.createTransport(smtpOptions)
  return await transporter.sendMail(msg)
}

// const infoFields = ['info', 'accepted', 'rejected', 'response', 'messageId']
// const createLogInfoRecord = info =>
//   Object.entries({ ...info, info }).reduce(
//     (acc, [key, value]) =>
//       infoFields.includes(key) ? { ...acc, [key]: { value: JSON.stringify(value) } } : acc,
//     {}
//   )

// const logInfo = async info => {
//   const logApp = getAppConfig('log')
//   if (!logApp) throw new Error('No log app config')
//   const { id, apiToken } = logApp
//   if (!id || !apiToken) throw new Error('Missing log app info')
//   try {
//     const record = getKintoneRecord(apiToken)
//     await record.addRecord({ app: id, record: createLogInfoRecord(info) })
//   } catch (error) {
//     console.error(error)
//     throw new Error(error)
//   }
// }

const getAppConfig = type => {
  return config.kintone.apps.find(app => app.type === type)
}

const getKintoneRecord = apiToken => {
  const auth = new kintoneJSSDK.Auth()
  auth.setApiToken({ apiToken })
  const connection = new kintoneJSSDK.Connection({ auth, domain: config.kintone.domain })
  return new kintoneJSSDK.Record({ connection })
}

// const fetchTemplateRecord = async () => {
//   const templateApp = getAppConfig('mailTemplate')
//   if (!templateApp) throw new Error('No template app config')
//   const { id, apiToken } = templateApp
//   if (!id || !apiToken) throw new Error('Missing template app info')
//   try {
//     const record = getKintoneRecord(apiToken)
//     const response = await record.getRecords({ app: id })
//     return response.records[0] || { error: `No template record on app ${id}` }
//   } catch (error) {
//     console.error(error)
//     throw new Error(error)
//   }
// }

const fetchOrderControlRecordsWithQuery = async (query, fields) => {
  const orderCtrlApp = getAppConfig('orderControl')
  if (!orderCtrlApp) throw new Error('No orderControl app config')
  const { id, apiToken } = orderCtrlApp
  if (!id || !apiToken) throw new Error('Missing orderControl app info')
  try {
    const record = getKintoneRecord(apiToken)
    const response = await record.getRecords({
      app: id,
      query: query,
      field: fields,
    })
    return response.records || { error: `No orderControl record on app ${id}` }
  } catch (error) {
    console.error(error)
    throw new Error(error)
  }
}

const checkUrlDomain = requestBody => {
  const hookUrl = (requestBody.url.match(/https?:\/\/(.*?)\//) || [])[1]
  return hookUrl === config.kintone.domain
}

const checkHookTypes = requestBody => {
  const {
    type,
    app: { id },
  } = requestBody
  return config.kintone.apps.find(
    app => app.type === 'orderControl' && app.id == id && app.types.includes(type)
  )
}

exports.receiveKintoneRecords = functions.https.onCall(async (data, context) => {
  try {
    admin.initializeApp()
    if (!context.auth) {
      // throw new functions.https.HttpsError(
      //   'failed-precondition',
      //   'The function must be called ' + 'while authenticated.'
      // )
    }
    for (const record of data.records) {
      const template = composeMail(record, data.mailTemplates)
      const msg = {
        to: template.toMailAddress,
        from: template.fromMailAddress,
        subject: template.subject,
        text: template.body,
      }
      console.info(template.smtpServer)
      switch (template.smtpServer) {
        case '楽天':
          await sendMailToSmtp('rakuten', msg)
          break
        default:
          await sendMailWithSg(msg)
      }
    }
  } catch (error) {
    console.error(error)
  }
})

exports.receiveHook = functions.https.onRequest(async (request, response) => {
  try {
    if (!checkUrlDomain(request.body)) {
      console.error('Bad Request')
      response.status(400).send('Bad Request')
      return
    }

    if (!checkHookTypes(request.body)) {
      const message = `Ignore hook ${request.body.type}`
      console.info(message)
      response.status(200).send(message)
      return
    }

    const fetchedRecords = await fetchOrderControlRecordsWithQuery(
      'thanksOrder in ("未") order by $id limit 5'
    )
    for (const record of fetchedRecords) {
      //      const info = await composeAndSendMail(record)
      // const info = await sendMailsWithSg(record)
      // await logInfo(info)
      console.info(record)
    }
    response.status(200).send('OK!')
  } catch (error) {
    console.error(error)
    response.status(400).send(error)
  }
})
