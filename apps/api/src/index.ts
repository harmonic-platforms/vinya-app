import Fastify from 'fastify'
import { google } from 'googleapis'
import axios from 'axios'
import { Prisma, ParsedLead, CrmIntegration } from '@prisma/client'
import { prisma } from '@vinya/db'

const server = Fastify({ logger: true })

const handleStdPipeErrors = () => {
  const handleError = (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE') {
      server.log.warn({ code: error.code, syscall: error.syscall }, 'STDOUT/STDERR EPIPE received; exiting gracefully')
      process.exit(0)
    }
  }

  process.stdout.on('error', handleError)
  process.stderr.on('error', handleError)
}

handleStdPipeErrors()

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI
const OAUTH_SCOPE = ['https://www.googleapis.com/auth/gmail.readonly']
const SEED_TENANT_NAME = 'Seed Tenant'

const createGoogleOAuthClient = () => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error(
      'Missing Google OAuth env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI',
    )
  }

  return new google.auth.OAuth2({
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    redirectUri: GOOGLE_REDIRECT_URI,
  })
}

const sendLeadToHubSpot = async (parsedLead: ParsedLead, crmIntegration: CrmIntegration) => {
  const token = crmIntegration.encryptedAccessToken
  if (!token) {
    server.log.error({ parsedLeadId: parsedLead.id }, 'Missing HubSpot access token on CRM integration')
    return null
  }

  const nameTokens = parsedLead.name?.trim().split(/\s+/) ?? []
  const firstname = nameTokens[0] ?? undefined
  const lastname = nameTokens.length > 1 ? nameTokens.slice(1).join(' ') : undefined

  const properties: Record<string, string> = {}
  if (firstname) properties.firstname = firstname
  if (lastname) properties.lastname = lastname
  if (parsedLead.email) properties.email = parsedLead.email
  if (parsedLead.phone) properties.phone = parsedLead.phone

  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts',
      { properties },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    )

    return response.data?.id ?? null
  } catch (error) {
    if (axios.isAxiosError(error)) {
      server.log.error({ status: error.response?.status, data: error.response?.data }, 'HubSpot contact creation failed')
    } else {
      server.log.error({ error }, 'HubSpot contact creation failed')
    }
    return null
  }
}

const getAuthenticatedGmailClient = async (emailAccountId: string) => {
  server.log.info({ emailAccountId }, 'Loading Gmail credentials for authenticated client')

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    include: { gmailCredential: true },
  })

  if (!emailAccount) {
    throw new Error('EmailAccount not found')
  }

  if (emailAccount.provider !== 'GMAIL') {
    throw new Error('EmailAccount provider is not GMAIL')
  }

  if (emailAccount.status !== 'CONNECTED') {
    throw new Error('EmailAccount is not connected')
  }

  const credential = emailAccount.gmailCredential
  if (!credential || !credential.encryptedAccessToken) {
    throw new Error('Gmail credentials not found for EmailAccount')
  }

  const oauth2Client = createGoogleOAuthClient()
  oauth2Client.setCredentials({
    access_token: credential.encryptedAccessToken,
    refresh_token: credential.encryptedRefreshToken ?? undefined,
    expiry_date: credential.tokenExpiresAt ? credential.tokenExpiresAt.getTime() : undefined,
  })

  return google.gmail({ version: 'v1', auth: oauth2Client })
}

const extractEmailBody = (payload: any): { bodyText: string | null; bodyHtml: string | null } => {
  const decodeBase64Url = (data: string): string => {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  }

  const extractFromParts = (parts: any[]): { text: string | null; html: string | null } => {
    let text: string | null = null
    let html: string | null = null

    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        text = decodeBase64Url(part.body.data)
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        html = decodeBase64Url(part.body.data)
      } else if (part.parts) {
        const subResult = extractFromParts(part.parts)
        if (!text && subResult.text) text = subResult.text
        if (!html && subResult.html) html = subResult.html
      }
    }

    return { text, html }
  }

  // Try payload.body.data first
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data)
    if (payload.mimeType === 'text/html') {
      return { bodyText: null, bodyHtml: decoded }
    } else {
      return { bodyText: decoded, bodyHtml: null }
    }
  }

  // Try multipart payload.parts
  if (payload.parts) {
    const { text, html } = extractFromParts(payload.parts)
    return { bodyText: text, bodyHtml: html }
  }

  return { bodyText: null, bodyHtml: null }
}

function extractLabeledField(text: string, label: string): string | null {
  const regex = new RegExp(`${label}:\\s*([^\\n\\r]+?)(?=\\s+\\w+:\\s*|$)`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
}

const isEligibleLeadMessage = (from: string | null, subject: string | null): boolean => {
  return from !== null && from.includes('mikeroit@gmail.com') && subject === 'New Lead'
}

const syncGmailHistory = async (emailAccountId: string, newHistoryId: string) => {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    include: { tenant: true },
  })

  if (!emailAccount) {
    throw new Error('EmailAccount not found')
  }

  const tenantId = emailAccount.tenantId
  server.log.info({ emailAccountId, newHistoryId, tenantId }, 'Starting Gmail history sync for tenant')

  const previousHistoryId = emailAccount.gmailHistoryId
  if (!previousHistoryId) {
    const currentEmailAccount = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } })
    const currentHistoryId = currentEmailAccount?.gmailHistoryId ? BigInt(currentEmailAccount.gmailHistoryId) : 0n
    const incoming = BigInt(newHistoryId)

    if (incoming > currentHistoryId) {
      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { gmailHistoryId: newHistoryId },
      })
      server.log.info({ emailAccountId, newHistoryId, tenantId }, 'Updated monotonic historyId for tenant')
    } else {
      server.log.info({ emailAccountId, newHistoryId, currentHistoryId: currentHistoryId.toString(), tenantId }, 'Skipped stale historyId update for tenant')
    }

    return { messageCount: 0, messageIds: [] as string[] }
  }

  const gmail = await getAuthenticatedGmailClient(emailAccountId)
  const historyResponse = await gmail.users.history.list({
    userId: 'me',
    startHistoryId: previousHistoryId,
  })

  const historyRecords = historyResponse.data.history ?? []
  const messageIds = new Set<string>()

  for (const record of historyRecords) {
    const added = record.messagesAdded ?? []
    for (const item of added) {
      const messageId = item.message?.id
      if (messageId) {
        messageIds.add(messageId)
      }
    }
  }

  const uniqueMessageIds = Array.from(messageIds)
  server.log.info({ tenantId, count: uniqueMessageIds.length, messageIds: uniqueMessageIds }, 'Messages found in history records for tenant')

  for (const messageId of uniqueMessageIds) {
    let messageResponse
    try {
      messageResponse = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
      })
    } catch (error) {
      const status = (error as any)?.code ?? (error as any)?.response?.status
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (status === 404) {
        server.log.warn({ messageId, emailAccountId, tenantId }, 'Skipping Gmail message not found')
        continue
      }

      server.log.error({ messageId, emailAccountId, tenantId, error: errorMessage }, 'Failed to fetch Gmail message')
      continue
    }

    const labelIds = messageResponse.data.labelIds ?? []
    if (!labelIds.includes('INBOX')) {
      server.log.info({ messageId, emailAccountId, tenantId, labelIds }, 'Skipping non-inbox Gmail message')
      continue
    }

    const payload = messageResponse.data.payload
    const headers = payload?.headers ?? []
    const headerMap = new Map<string, string>()
    for (const header of headers) {
      if (header.name && header.value) {
        headerMap.set(header.name, header.value)
      }
    }

    const { bodyText, bodyHtml } = extractEmailBody(payload)

    const savedInboundMessage = await prisma.inboundMessage.upsert({
      where: { gmailMessageId: messageId },
      update: {
        threadId: messageResponse.data.threadId ?? '',
        from: headerMap.get('From') ?? null,
        subject: headerMap.get('Subject') ?? null,
        snippet: messageResponse.data.snippet ?? null,
        bodyText,
        bodyHtml,
        receivedAt: headerMap.get('Date') ? new Date(headerMap.get('Date')!) : null,
        rawHeaders: headers as unknown as Prisma.InputJsonValue,
      },
      create: {
        emailAccountId,
        gmailMessageId: messageId,
        threadId: messageResponse.data.threadId ?? '',
        from: headerMap.get('From') ?? null,
        subject: headerMap.get('Subject') ?? null,
        snippet: messageResponse.data.snippet ?? null,
        bodyText,
        bodyHtml,
        receivedAt: headerMap.get('Date') ? new Date(headerMap.get('Date')!) : null,
        rawHeaders: headers as unknown as Prisma.InputJsonValue,
      },
    })

    if (!isEligibleLeadMessage(savedInboundMessage.from, savedInboundMessage.subject)) {
      server.log.info({ inboundMessageId: savedInboundMessage.id, from: savedInboundMessage.from, subject: savedInboundMessage.subject }, 'Skipping non-lead message')
      continue
    } else {
      server.log.info({ inboundMessageId: savedInboundMessage.id }, 'Eligible lead message detected')
    }

    const existingParsedLead = await prisma.parsedLead.findUnique({
      where: { inboundMessageId: savedInboundMessage.id },
    })

    let parsedLead = existingParsedLead
    if (parsedLead) {
      server.log.info({ parsedLeadId: parsedLead.id, inboundMessageId: savedInboundMessage.id }, 'Skipped duplicate parse for inbound message')
    } else {
      try {
        const parsedData = parseLeadFromMessage({
          from: savedInboundMessage.from,
          subject: savedInboundMessage.subject,
          snippet: savedInboundMessage.snippet,
          bodyText: savedInboundMessage.bodyText,
        })

        const rawText = savedInboundMessage.bodyText || `${savedInboundMessage.subject || ''} ${savedInboundMessage.snippet || ''}`.trim()
        parsedLead = await prisma.parsedLead.create({
          data: {
            emailAccountId,
            inboundMessageId: savedInboundMessage.id,
            source: parsedData.source,
            name: parsedData.name,
            email: parsedData.email,
            phone: parsedData.phone,
            message: parsedData.message,
            rawText,
            parseStatus: parsedData.parseStatus,
            crmPushStatus: 'PENDING',
          },
        })

        server.log.info({ tenantId, parsedLeadId: parsedLead.id, inboundMessageId: savedInboundMessage.id }, 'Parsed lead created for tenant')
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown parse error'
        await prisma.parsedLead.create({
          data: {
            emailAccountId,
            inboundMessageId: savedInboundMessage.id,
            source: 'unknown',
            rawText: savedInboundMessage.bodyText || `${savedInboundMessage.subject || ''} ${savedInboundMessage.snippet || ''}`.trim(),
            parseStatus: 'FAILED',
            crmPushStatus: 'FAILED',
            crmPushError: errorMessage,
            crmAttemptCount: 0,
          },
        })
        server.log.error({ inboundMessageId: savedInboundMessage.id, error: errorMessage }, 'Failed to parse inbound message')
        continue
      }
    }

    if (parsedLead && parsedLead.parseStatus === 'SUCCESS') {
      if (parsedLead.crmPushed) {
        server.log.info({ parsedLeadId: parsedLead.id }, 'Skipped duplicate HubSpot push for parsed lead')
      } else {
        try {
          // Get tenant from email account
          const emailAccount = await prisma.emailAccount.findUnique({
            where: { id: emailAccountId },
            include: { tenant: true },
          })

          if (!emailAccount) {
            server.log.error({ emailAccountId }, 'EmailAccount not found during HubSpot push')
            continue
          }

          const tenantId = emailAccount.tenantId
          server.log.info({ tenantId, parsedLeadId: parsedLead.id }, 'Processing HubSpot push for tenant')

          const hubspotIntegration = await prisma.crmIntegration.findFirst({
            where: {
              tenantId,
              provider: 'HUBSPOT',
              status: 'CONNECTED',
            },
          })

          if (hubspotIntegration) {
            const hubspotId = await sendLeadToHubSpot(parsedLead, hubspotIntegration)
            if (hubspotId) {
              await prisma.parsedLead.update({
                where: { id: parsedLead.id },
                data: {
                  crmPushed: true,
                  crmProvider: 'HUBSPOT',
                  crmRecordId: hubspotId,
                  crmPushedAt: new Date(),
                  crmPushStatus: 'SUCCESS',
                  crmAttemptCount: { increment: 1 },
                },
              })
              server.log.info({ tenantId, parsedLeadId: parsedLead.id, crmRecordId: hubspotId }, 'Lead pushed to HubSpot for tenant')
            } else {
              await prisma.parsedLead.update({
                where: { id: parsedLead.id },
                data: {
                  crmPushStatus: 'FAILED',
                  crmAttemptCount: { increment: 1 },
                  crmPushError: 'HubSpot push returned no contact id',
                },
              })
              server.log.error({ tenantId, parsedLeadId: parsedLead.id }, 'Failed to push parsed lead to HubSpot: no contact id returned')
            }
          } else {
            server.log.info({ tenantId, parsedLeadId: parsedLead.id }, 'No connected HubSpot integration found for tenant; skipping push')
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown HubSpot push error'
          await prisma.parsedLead.update({
            where: { id: parsedLead.id },
            data: {
              crmPushStatus: 'FAILED',
              crmAttemptCount: { increment: 1 },
              crmPushError: errorMessage,
            },
          })
          server.log.error({ parsedLeadId: parsedLead.id, error: errorMessage }, 'Error pushing parsed lead to HubSpot')
        }
      }
    }
  }

  const currentEmailAccount = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } })
  const currentHistoryId = currentEmailAccount?.gmailHistoryId ? BigInt(currentEmailAccount.gmailHistoryId) : 0n
  const incoming = BigInt(newHistoryId)

  if (incoming > currentHistoryId) {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { gmailHistoryId: newHistoryId },
    })
    server.log.info({ emailAccountId, newHistoryId, tenantId }, 'Updated monotonic historyId for tenant')
  } else {
    server.log.info({ emailAccountId, newHistoryId, currentHistoryId: currentHistoryId.toString(), tenantId }, 'Skipped stale historyId update for tenant')
  }

  return { messageCount: uniqueMessageIds.length, messageIds: uniqueMessageIds }
}

const parseLeadFromMessage = (message: {
  from: string | null
  subject: string | null
  snippet: string | null
  bodyText: string | null
}) => {
  const { from, subject, snippet, bodyText } = message
  const rawText = bodyText || `${subject || ''} ${snippet || ''}`.trim()

  // Determine source
  let source = 'unknown'
  if (from?.toLowerCase().includes('realtor.com')) {
    source = 'realtor'
  } else if (from?.toLowerCase().includes('zillow')) {
    source = 'zillow'
  } else if (rawText.includes('Lead ID:') && rawText.includes('Lead Information:')) {
    source = 'mortgage_lead_provider'
  }

  // Extract email - try labeled first, then generic
  const labeledEmail = extractLabeledField(rawText, "Email");
  const genericEmailMatch = rawText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i);
  const genericEmail = genericEmailMatch ? genericEmailMatch[0] : null;
  const email = labeledEmail ?? genericEmail;

  // Extract phone - try labeled first, then generic
  let phone = null
  const labeledPhoneMatch = rawText.match(/Phone Number:\s*(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/i)
  if (labeledPhoneMatch) {
    phone = labeledPhoneMatch[1]
  } else {
    const genericPhoneMatch = rawText.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)
    if (genericPhoneMatch) {
      phone = genericPhoneMatch[0]
    }
  }

  // Extract name - try labeled first, then generic
  let name = null
  const labeledNameMatch = rawText.match(/Lead Name:\s*([^\n]+?)(?=\s+Phone Number:|\s+Email:|$)/i)
  if (labeledNameMatch) {
    name = labeledNameMatch[1].trim()
  } else {
    const genericNameMatch = rawText.match(/^[A-Z][a-z]+ [A-Z][a-z]+/)
    if (genericNameMatch) {
      name = genericNameMatch[0]
    }
  }

  // Extract additional labeled fields
  const creditRating = extractLabeledField(rawText, 'Credit Rating')
  const propertyCounty = extractLabeledField(rawText, 'Property County')
  const propertyState = extractLabeledField(rawText, 'Property State')
  const propertyZip = extractLabeledField(rawText, 'Property Zip')
  const propertyValue = extractLabeledField(rawText, 'Property Value')
  const servedInMilitary = extractLabeledField(rawText, 'Served in Military')
  const bankruptcy = extractLabeledField(rawText, 'Bankruptcy')
  const loanType = extractLabeledField(rawText, 'Loan Type')
  const militaryBranch = extractLabeledField(rawText, 'Military Branch')
  const hasRealEstateAgent = extractLabeledField(rawText, 'Has Real Estate Agent')
  const downPaymentPercent = extractLabeledField(rawText, 'Down Payment Percent')
  const propertyType = extractLabeledField(rawText, 'Property Type')
  const propertyUse = extractLabeledField(rawText, 'Property Use')
  const loanProduct = extractLabeledField(rawText, 'Loan Product')
  const employmentStatus = extractLabeledField(rawText, 'Employment Status')
  const grossIncome = extractLabeledField(rawText, 'Gross Income')
  const firstTimePurchase = extractLabeledField(rawText, 'First Time purchase')
  const livingSituation = extractLabeledField(rawText, 'Living Situation')
  const purchaseStatus = extractLabeledField(rawText, 'Purchase Status')
  const downPayment = extractLabeledField(rawText, 'Down Payment')
  const propertyCity = extractLabeledField(rawText, 'Property City')

  // Message fallback to snippet
  const messageText = snippet || rawText

  return {
    source,
    name,
    email,
    phone,
    message: messageText,
    parseStatus: 'SUCCESS' as const,
    // Additional extracted fields
    creditRating,
    propertyCounty,
    propertyState,
    propertyZip,
    propertyValue,
    servedInMilitary,
    bankruptcy,
    loanType,
    militaryBranch,
    hasRealEstateAgent,
    downPaymentPercent,
    propertyType,
    propertyUse,
    loanProduct,
    employmentStatus,
    grossIncome,
    firstTimePurchase,
    livingSituation,
    purchaseStatus,
    downPayment,
    propertyCity,
  }
}

server.post('/dev/create-tenant', async (request, reply) => {
  const body = request.body as { name?: string; email?: string }

  const name = body.name?.trim()
  const email = body.email?.trim()

  if (!name || !email) {
    return reply.status(400).send({ success: false, message: 'Missing name or email' })
  }

  try {
    server.log.info({ tenantName: name, adminEmail: email }, 'Creating new tenant with admin user')

    const tenant = await prisma.tenant.create({
      data: { name },
    })

    const user = await prisma.user.create({
      data: { email },
    })

    const membership = await prisma.membership.create({
      data: {
        role: 'admin',
        userId: user.id,
        tenantId: tenant.id,
      },
    })

    server.log.info({ tenantId: tenant.id, userId: user.id, membershipId: membership.id }, 'Created tenant, user, and admin membership')

    return {
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        createdAt: tenant.createdAt,
      },
      user: {
        id: user.id,
        email: user.email,
        createdAt: user.createdAt,
      },
      membership: {
        id: membership.id,
        role: membership.role,
        createdAt: membership.createdAt,
      },
    }
  } catch (error) {
    server.log.error({ error, tenantName: name, adminEmail: email }, 'Error creating tenant')
    return reply.status(500).send({ success: false, message: 'Failed to create tenant' })
  }
})

server.get('/auth/google', async (request, reply) => {
  const query = request.query as { tenantId?: string }
  const tenantId = query.tenantId?.trim()

  if (!tenantId) {
    server.log.warn({ query }, 'Missing tenantId in Google OAuth request')
    return reply.status(400).send({ success: false, message: 'Missing tenantId' })
  }

  // Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) {
    server.log.warn({ tenantId }, 'Tenant not found for Google OAuth')
    return reply.status(404).send({ success: false, message: 'Tenant not found' })
  }

  server.log.info({ tenantId }, 'Generating Google OAuth consent screen URL for tenant')

  const oauth2Client = createGoogleOAuthClient()
  const state = JSON.stringify({ tenantId })
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE,
    state,
  })

  server.log.info({ authUrl, tenantId }, 'Redirecting to Google OAuth URL')
  return reply.redirect(authUrl)
})

server.get('/auth/google/callback', async (request, reply) => {
  const query = request.query as { code?: string; state?: string }
  const code = String(query.code ?? '')
  const state = query.state

  if (!code) {
    server.log.warn({ query }, 'Missing code in Google OAuth callback')
    return reply.status(400).send({ success: false, message: 'Missing OAuth code' })
  }

  if (!state) {
    server.log.warn({ query }, 'Missing state in Google OAuth callback')
    return reply.status(400).send({ success: false, message: 'Missing OAuth state' })
  }

  let tenantId: string
  try {
    const stateData = JSON.parse(state)
    tenantId = stateData.tenantId
  } catch (error) {
    server.log.warn({ state, error }, 'Invalid state format in Google OAuth callback')
    return reply.status(400).send({ success: false, message: 'Invalid OAuth state' })
  }

  // Verify tenant exists
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) {
    server.log.warn({ tenantId }, 'Tenant not found for Google OAuth callback')
    return reply.status(404).send({ success: false, message: 'Tenant not found' })
  }

  server.log.info({ code: '[REDACTED]', tenantId }, 'Received Google OAuth callback code for tenant')

  try {
    const oauth2Client = createGoogleOAuthClient()
    const tokenResponse = await oauth2Client.getToken(code)

    const tokens = tokenResponse.tokens
    oauth2Client.setCredentials(tokens)

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })
    const profileResponse = await gmail.users.getProfile({ userId: 'me' })

    const emailAddress = profileResponse.data.emailAddress
    if (!emailAddress) {
      server.log.error({ profile: profileResponse.data }, 'Google profile did not return an email address')
      return reply.status(500).send({ success: false, message: 'Could not determine Gmail address' })
    }

    server.log.info({ emailAddress, tenantId }, 'Fetched Gmail profile email address for tenant')

    const emailAccount = await prisma.emailAccount.upsert({
      where: {
        tenantId_provider_emailAddress: {
          tenantId,
          provider: 'GMAIL',
          emailAddress,
        },
      },
      update: {
        status: 'CONNECTED',
      },
      create: {
        tenantId,
        provider: 'GMAIL',
        emailAddress,
        status: 'CONNECTED',
      },
    })

    const tokenExpiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null
    const gmailCredential = await prisma.gmailCredential.upsert({
      where: {
        emailAccountId: emailAccount.id,
      },
      update: {
        encryptedAccessToken: tokens.access_token ?? null,
        encryptedRefreshToken: tokens.refresh_token ?? null,
        tokenExpiresAt,
        scopes: OAUTH_SCOPE,
      },
      create: {
        emailAccountId: emailAccount.id,
        encryptedAccessToken: tokens.access_token ?? null,
        encryptedRefreshToken: tokens.refresh_token ?? null,
        tokenExpiresAt,
        scopes: OAUTH_SCOPE,
      },
    })

    server.log.info(
      { tenantId, emailAccountId: emailAccount.id, gmailCredentialId: gmailCredential.id },
      'Saved Gmail credentials for tenant',
    )

    return {
      success: true,
      tenantId,
      emailAddress,
      emailAccountId: emailAccount.id,
      gmailCredentialId: gmailCredential.id,
    }
  } catch (error) {
    server.log.error({ error, tenantId }, 'Error during Gmail OAuth callback processing')
    return reply.status(500).send({ success: false, message: 'Gmail OAuth callback failed' })
  }
})

server.get('/dev/gmail/messages', async (request, reply) => {
  server.log.info('Reading recent Gmail messages for connected account')

  try {
    const emailAccount = await prisma.emailAccount.findFirst({
      where: {
        provider: 'GMAIL',
        status: 'CONNECTED',
      },
    })

    if (!emailAccount) {
      server.log.warn('No connected Gmail EmailAccount found')
      return reply.status(404).send({ success: false, message: 'No connected Gmail account found' })
    }

    const gmail = await getAuthenticatedGmailClient(emailAccount.id)
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 5,
    })

    const gmailMessages = listResponse.data.messages ?? []
    server.log.info({ count: gmailMessages.length }, 'Found recent Gmail message IDs')

    const messages = [] as Array<{
      id: string
      from: string | null
      subject: string | null
      date: string | null
      snippet: string | null
      bodyText: string | null
    }>

    for (const messageMeta of gmailMessages) {
      if (!messageMeta.id) {
        continue
      }

      const messageResponse = await gmail.users.messages.get({
        userId: 'me',
        id: messageMeta.id,
      })

      const payload = messageResponse.data.payload
      const headers = payload?.headers ?? []
      const headerMap = new Map<string, string>()

      for (const header of headers) {
        if (header.name && header.value) {
          headerMap.set(header.name, header.value)
        }
      }

      const { bodyText } = extractEmailBody(payload)

      messages.push({
        id: messageResponse.data.id ?? messageMeta.id,
        from: headerMap.get('From') ?? null,
        subject: headerMap.get('Subject') ?? null,
        date: headerMap.get('Date') ?? null,
        snippet: messageResponse.data.snippet ?? null,
        bodyText,
      })
    }

    return { messages }
  } catch (error) {
    server.log.error({ error }, 'Error fetching Gmail messages')
    return reply.status(500).send({ success: false, message: 'Failed to read Gmail messages' })
  }
})

server.post('/dev/pubsub', async (request, reply) => {
  const body = request.body as { message?: { data?: string } }
  if (!body.message?.data) {
    server.log.warn({ body }, 'Invalid PubSub message format')
    return reply.status(200).send({ received: false, processed: false, error: 'Invalid message format' })
  }

  const decoded = JSON.parse(
    Buffer.from(body.message.data, 'base64').toString()
  ) as { emailAddress?: string; historyId?: string }

  const emailAddress = decoded.emailAddress
  const historyId = decoded.historyId
  request.log.info({ pubsubEvent: decoded }, 'Received PubSub event')

  if (!emailAddress || !historyId) {
    request.log.warn({ emailAddress, historyId }, 'PubSub event missing emailAddress or historyId')
    return reply.status(200).send({ received: true, processed: false, error: 'Missing emailAddress or historyId' })
  }

  const emailAccount = await prisma.emailAccount.findFirst({
    where: {
      provider: 'GMAIL',
      emailAddress,
    },
    include: { tenant: true },
  })

  if (!emailAccount) {
    request.log.warn({ emailAddress }, 'No connected Gmail EmailAccount found for PubSub event')
    return reply.status(200).send({ received: true, processed: false, error: 'Email account not found' })
  }

  const tenantId = emailAccount.tenantId
  request.log.info({ emailAddress, historyId, tenantId }, 'Processing PubSub event for tenant')

  try {
    const syncResult = await syncGmailHistory(emailAccount.id, String(historyId))
    server.log.info({ tenantId, syncResult }, 'Completed Gmail history sync for PubSub event')
    return reply.status(200).send({ received: true, processed: true, tenantId, ...syncResult })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    server.log.error({ emailAddress, historyId, error: errorMessage }, 'Error processing PubSub event')
    return reply.status(200).send({ received: true, processed: false, error: errorMessage })
  }
})

const registerGmailWatchForAccount = async (emailAccount: { id: string }) => {
  const gmail = await getAuthenticatedGmailClient(emailAccount.id)
  const watchResponse = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: 'projects/vinya-prod/topics/gmail-events',
    },
  })

  const historyId = watchResponse.data.historyId
  const expiration = watchResponse.data.expiration

  if (!historyId || !expiration) {
    throw new Error('Gmail watch response missing historyId or expiration')
  }

  const updatedAccount = await prisma.emailAccount.update({
    where: { id: emailAccount.id },
    data: {
      gmailHistoryId: historyId,
      watchExpiration: new Date(parseInt(expiration)),
    },
  })

  return {
    emailAccount: updatedAccount,
    historyId,
    expiration,
  }
}

server.post('/dev/gmail/watch/:emailAccountId', async (request, reply) => {
  const { emailAccountId } = request.params as { emailAccountId: string }

  if (!emailAccountId) {
    request.log.warn('Missing emailAccountId in Gmail watch request')
    return reply.status(400).send({ success: false, message: 'Missing emailAccountId' })
  }

  server.log.info({ emailAccountId }, 'Registering Gmail watch for EmailAccount ID')

  try {
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
    })

    if (!emailAccount) {
      request.log.warn({ emailAccountId }, 'EmailAccount not found for Gmail watch')
      return reply.status(404).send({ success: false, message: 'EmailAccount not found' })
    }

    if (emailAccount.provider !== 'GMAIL' || emailAccount.status !== 'CONNECTED') {
      request.log.warn({ emailAccountId, provider: emailAccount.provider, status: emailAccount.status }, 'EmailAccount is not a connected Gmail account')
      return reply.status(400).send({ success: false, message: 'EmailAccount must be a connected Gmail account' })
    }

    const emailAddress = emailAccount.emailAddress
    const tenantId = emailAccount.tenantId
    request.log.info({ tenantId, emailAccountId, emailAddress }, 'Found Gmail EmailAccount for watch registration')

    const watchResult = await registerGmailWatchForAccount(emailAccount)

    request.log.info({ tenantId, emailAccountId, emailAddress, historyId: watchResult.historyId, expiration: watchResult.expiration }, 'Gmail watch registered and saved to DB for tenant')

    return {
      success: true,
      emailAccountId: emailAccount.id,
      emailAddress,
      historyId: watchResult.historyId,
      expiration: watchResult.expiration,
    }
  } catch (error) {
    request.log.error({ error, emailAccountId }, 'Error registering Gmail watch for EmailAccount ID')
    return reply.status(500).send({ success: false, message: 'Failed to register Gmail watch' })
  }
})

server.post('/dev/gmail/watch', async (request, reply) => {
  const body = (request.body ?? {}) as { tenantId?: string; emailAccountId?: string }
  const query = (request.query ?? {}) as { tenantId?: string; emailAccountId?: string }
  const emailAccountId = body.emailAccountId?.trim() || query.emailAccountId?.trim()
  const tenantId = body.tenantId?.trim() || query.tenantId?.trim()

  if (!emailAccountId && !tenantId) {
    request.log.warn({ tenantId, emailAccountId }, 'Missing tenantId and emailAccountId in Gmail watch request')
    return reply.status(400).send({ success: false, message: 'Missing tenantId or emailAccountId' })
  }

  request.log.info({ tenantId, emailAccountId }, 'Registering Gmail watch via fallback route')

  try {
    let emailAccount
    if (emailAccountId) {
      emailAccount = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } })
    } else {
      emailAccount = await prisma.emailAccount.findFirst({
        where: {
          provider: 'GMAIL',
          status: 'CONNECTED',
          tenantId: tenantId!,
        },
      })
    }

    if (!emailAccount) {
      request.log.warn({ tenantId, emailAccountId }, 'EmailAccount not found for fallback Gmail watch route')
      return reply.status(404).send({ success: false, message: 'EmailAccount not found' })
    }

    if (emailAccount.provider !== 'GMAIL' || emailAccount.status !== 'CONNECTED') {
      request.log.warn({ emailAccountId: emailAccount.id, provider: emailAccount.provider, status: emailAccount.status }, 'EmailAccount is not a connected Gmail account')
      return reply.status(400).send({ success: false, message: 'EmailAccount must be a connected Gmail account' })
    }

    const emailAddress = emailAccount.emailAddress
    const resolvedTenantId = emailAccount.tenantId

    const watchResult = await registerGmailWatchForAccount(emailAccount)

    request.log.info({ tenantId: resolvedTenantId, emailAccountId: emailAccount.id, emailAddress, historyId: watchResult.historyId, expiration: watchResult.expiration }, 'Gmail watch registered and saved to DB via fallback route')

    return {
      success: true,
      emailAccountId: emailAccount.id,
      emailAddress,
      historyId: watchResult.historyId,
      expiration: watchResult.expiration,
    }
  } catch (error) {
    request.log.error({ error, tenantId, emailAccountId }, 'Error registering Gmail watch via fallback route')
    return reply.status(500).send({ success: false, message: 'Failed to register Gmail watch' })
  }
})

server.post('/dev/seed', async () => {
  const tenantName = 'Seed Tenant'
  const email = 'seed@example.com'

  const createdTenant = await prisma.tenant.create({
    data: {
      name: tenantName,
    },
  })

  const createdUser = await prisma.user.create({
    data: {
      email,
    },
  })

  const createdMembership = await prisma.membership.create({
    data: {
      role: 'admin',
      userId: createdUser.id,
      tenantId: createdTenant.id,
    },
  })

  return {
    tenant: createdTenant,
    user: createdUser,
    membership: createdMembership,
  }
})

server.post('/dev/seed-integrations', async () => {
  const tenantName = 'Seed Tenant'
  const emailAddress = 'seed@gmail.com'

  let tenant = await prisma.tenant.findFirst({
    where: { name: tenantName },
  })

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: tenantName },
    })
  }

  const emailAccount = await prisma.emailAccount.upsert({
    where: {
      tenantId_provider_emailAddress: {
        tenantId: tenant.id,
        provider: 'GMAIL',
        emailAddress,
      },
    },
    update: {
      status: 'DISCONNECTED',
    },
    create: {
      tenantId: tenant.id,
      provider: 'GMAIL',
      emailAddress,
      status: 'DISCONNECTED',
    },
  })

  const gmailCredential = await prisma.gmailCredential.upsert({
    where: {
      emailAccountId: emailAccount.id,
    },
    update: {
      encryptedAccessToken: 'fake-access-token',
      encryptedRefreshToken: 'fake-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
    create: {
      emailAccountId: emailAccount.id,
      encryptedAccessToken: 'fake-access-token',
      encryptedRefreshToken: 'fake-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 1000 * 60 * 60),
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    },
  })

  const crmIntegration = await prisma.crmIntegration.upsert({
    where: {
      tenantId_provider: {
        tenantId: tenant.id,
        provider: 'CLOSE',
      },
    },
    update: {
      status: 'DISCONNECTED',
      encryptedAccessToken: 'fake-crm-access-token',
      encryptedRefreshToken: 'fake-crm-refresh-token',
      accountName: 'Seed Close Account',
    },
    create: {
      tenantId: tenant.id,
      provider: 'CLOSE',
      status: 'DISCONNECTED',
      accountName: 'Seed Close Account',
      encryptedAccessToken: 'fake-crm-access-token',
      encryptedRefreshToken: 'fake-crm-refresh-token',
    },
  })

  return {
    tenant,
    emailAccount,
    gmailCredential,
    crmIntegration,
  }
})

server.get('/dev/tenants', async () => {
  const tenants = await prisma.tenant.findMany({
    include: {
      memberships: {
        include: {
          user: true,
        },
      },
      emailAccounts: {
        include: {
          gmailCredential: true,
        },
      },
      crmIntegrations: true,
    },
  })

  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    users: tenant.memberships.map((membership) => ({
      id: membership.user.id,
      email: membership.user.email,
      createdAt: membership.user.createdAt,
      role: membership.role,
    })),
    emailAccounts: tenant.emailAccounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      emailAddress: account.emailAddress,
      status: account.status,
      gmailCredential: account.gmailCredential
        ? {
            id: account.gmailCredential.id,
            encryptedAccessToken: account.gmailCredential.encryptedAccessToken,
            encryptedRefreshToken: account.gmailCredential.encryptedRefreshToken,
            tokenExpiresAt: account.gmailCredential.tokenExpiresAt,
            scopes: account.gmailCredential.scopes,
          }
        : null,
    })),
    crmIntegrations: tenant.crmIntegrations.map((integration) => ({
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      accountName: integration.accountName,
      encryptedAccessToken: integration.encryptedAccessToken,
      tokenExpiresAt: integration.tokenExpiresAt,
    })),
  }))
})

server.get('/dev/integrations', async () => {
  const tenants = await prisma.tenant.findMany({
    include: {
      emailAccounts: {
        include: {
          gmailCredential: true,
        },
      },
      crmIntegrations: true,
    },
  })

  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
    emailAccounts: tenant.emailAccounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      emailAddress: account.emailAddress,
      status: account.status,
      gmailCredential: account.gmailCredential
        ? {
            id: account.gmailCredential.id,
            encryptedAccessToken: account.gmailCredential.encryptedAccessToken,
            encryptedRefreshToken: account.gmailCredential.encryptedRefreshToken,
            tokenExpiresAt: account.gmailCredential.tokenExpiresAt,
            scopes: account.gmailCredential.scopes,
          }
        : null,
    })),
    crmIntegrations: tenant.crmIntegrations,
  }))
})

server.get('/dev/inbound-messages', async (request, reply) => {
  request.log.info('Fetching recent inbound messages')

  try {
    const messages = await prisma.inboundMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        gmailMessageId: true,
        threadId: true,
        from: true,
        subject: true,
        snippet: true,
        bodyText: true,
        receivedAt: true,
        createdAt: true,
      },
    })

    request.log.info({ count: messages.length }, 'Retrieved inbound messages')
    return { messages }
  } catch (error) {
    request.log.error({ error }, 'Error fetching inbound messages')
    return reply.status(500).send({ success: false, message: 'Failed to fetch inbound messages' })
  }
})

server.post('/dev/parse-message/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  request.log.info({ inboundMessageId: id }, 'Parsing lead from inbound message')

  try {
    const inboundMessage = await prisma.inboundMessage.findUnique({
      where: { id },
      include: { emailAccount: true },
    })

    if (!inboundMessage) {
      request.log.warn({ inboundMessageId: id }, 'Inbound message not found')
      return reply.status(404).send({ success: false, message: 'Inbound message not found' })
    }

    // Debug logging
    request.log.info({
      inboundMessageId: inboundMessage.id,
      snippet: inboundMessage.snippet,
      bodyText: inboundMessage.bodyText
    }, 'Inbound message data before parsing')

    const rawText = inboundMessage.bodyText || inboundMessage.snippet || ""
    request.log.info({ rawText }, 'Raw text passed to parseLeadFromMessage')

    // Extract email for debugging
    const labeledEmail = extractLabeledField(rawText, "Email");
    const genericEmail = rawText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null;

    const parsedData = parseLeadFromMessage({
      from: inboundMessage.from,
      subject: inboundMessage.subject,
      snippet: inboundMessage.snippet,
      bodyText: inboundMessage.bodyText,
    })

    const parsedLead = await prisma.parsedLead.upsert({
      where: { inboundMessageId: id },
      update: {
        source: parsedData.source,
        name: parsedData.name,
        email: parsedData.email,
        phone: parsedData.phone,
        message: parsedData.message,
        rawText,
        parseStatus: parsedData.parseStatus,
      },
      create: {
        emailAccountId: inboundMessage.emailAccountId,
        inboundMessageId: id,
        source: parsedData.source,
        name: parsedData.name,
        email: parsedData.email,
        phone: parsedData.phone,
        message: parsedData.message,
        rawText,
        parseStatus: parsedData.parseStatus,
      },
    })

    request.log.info({ parsedLeadId: parsedLead.id, parseStatus: parsedData.parseStatus }, 'Parsed and saved lead')
    return {
      success: true,
      parsedLead,
      debug: {
        hasBodyText: Boolean(inboundMessage.bodyText),
        bodyTextLength: inboundMessage.bodyText?.length ?? 0,
        rawText,
        labeledEmail,
        genericEmail
      }
    }
  } catch (error) {
    request.log.error({ error, inboundMessageId: id }, 'Error parsing lead from message')
    return reply.status(500).send({ success: false, message: 'Failed to parse lead' })
  }
})

server.get('/dev/parsed-leads', async (request, reply) => {
  request.log.info('Fetching recent parsed leads')

  try {
    const leads = await prisma.parsedLead.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        emailAccountId: true,
        inboundMessageId: true,
        source: true,
        name: true,
        email: true,
        phone: true,
        message: true,
        parseStatus: true,
        createdAt: true,
      },
    })

    request.log.info({ count: leads.length }, 'Retrieved parsed leads')
    return { leads }
  } catch (error) {
    request.log.error({ error }, 'Error fetching parsed leads')
    return reply.status(500).send({ success: false, message: 'Failed to fetch parsed leads' })
  }
})

server.post('/dev/push-lead-hubspot/:id', async (request, reply) => {
  const { id } = request.params as { id: string }
  request.log.info({ parsedLeadId: id }, 'Pushing parsed lead to HubSpot')

  try {
    const parsedLead = await prisma.parsedLead.findUnique({ where: { id } })
    if (!parsedLead) {
      request.log.warn({ parsedLeadId: id }, 'ParsedLead not found')
      return reply.status(404).send({ success: false, message: 'ParsedLead not found' })
    }

    // Get tenant from email account
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: parsedLead.emailAccountId },
      include: { tenant: true },
    })

    if (!emailAccount) {
      request.log.warn({ parsedLeadId: id, emailAccountId: parsedLead.emailAccountId }, 'EmailAccount not found for parsed lead')
      return reply.status(404).send({ success: false, message: 'Email account not found' })
    }

    const tenantId = emailAccount.tenantId
    request.log.info({ parsedLeadId: id, tenantId }, 'Pushing parsed lead to HubSpot for tenant')

    const crmIntegration = await prisma.crmIntegration.findFirst({
      where: {
        tenantId,
        provider: 'HUBSPOT',
        status: 'CONNECTED',
      },
    })

    if (!crmIntegration) {
      request.log.warn({ tenantId }, 'No connected HubSpot CRM integration found for tenant')
      return reply.status(404).send({ success: false, message: 'No connected HubSpot integration found' })
    }

    const hubspotId = await sendLeadToHubSpot(parsedLead, crmIntegration)
    if (!hubspotId) {
      return reply.status(500).send({ success: false, message: 'Failed to push lead to HubSpot' })
    }

    const updatedLead = await prisma.parsedLead.update({
      where: { id },
      data: {
        crmPushed: true,
        crmProvider: 'HUBSPOT',
        crmRecordId: hubspotId,
        crmPushedAt: new Date(),
      },
    })

    return { success: true, parsedLead: updatedLead }
  } catch (error) {
    request.log.error({ error, parsedLeadId: id }, 'Error pushing parsed lead to HubSpot')
    return reply.status(500).send({ success: false, message: 'Failed to push lead to HubSpot' })
  }
})

server.post('/dev/retry-failed-leads', async (request, reply) => {
  request.log.info('Retrying failed HubSpot pushes for parsed leads')

  try {
    // Get all tenants with connected HubSpot integrations
    const tenantsWithHubSpot = await prisma.tenant.findMany({
      include: {
        crmIntegrations: {
          where: {
            provider: 'HUBSPOT',
            status: 'CONNECTED',
          },
        },
      },
    })

    const results = [] as Array<{ tenantId: string; id: string; success: boolean; message: string }>

    for (const tenant of tenantsWithHubSpot) {
      const hubspotIntegration = tenant.crmIntegrations[0]
      if (!hubspotIntegration) continue

      request.log.info({ tenantId: tenant.id }, 'Retrying failed HubSpot pushes for tenant')

      // Get failed leads for this tenant
      const failedLeads = await prisma.parsedLead.findMany({
        where: {
          crmPushStatus: 'FAILED',
          emailAccount: {
            tenantId: tenant.id,
          },
        },
      })

      for (const lead of failedLeads) {
        if (lead.crmPushed) {
          request.log.info({ parsedLeadId: lead.id, tenantId: tenant.id }, 'Skipping already pushed lead during retry')
          results.push({ tenantId: tenant.id, id: lead.id, success: true, message: 'Already pushed' })
          continue
        }

        try {
          const hubspotId = await sendLeadToHubSpot(lead, hubspotIntegration)
          if (hubspotId) {
            await prisma.parsedLead.update({
              where: { id: lead.id },
              data: {
                crmPushed: true,
                crmProvider: 'HUBSPOT',
                crmRecordId: hubspotId,
                crmPushedAt: new Date(),
                crmPushStatus: 'SUCCESS',
                crmAttemptCount: { increment: 1 },
                crmPushError: null,
              },
            })
            request.log.info({ parsedLeadId: lead.id, tenantId: tenant.id, crmRecordId: hubspotId }, 'Retried HubSpot push succeeded')
            results.push({ tenantId: tenant.id, id: lead.id, success: true, message: 'Retried successfully' })
          } else {
            await prisma.parsedLead.update({
              where: { id: lead.id },
              data: {
                crmPushStatus: 'FAILED',
                crmAttemptCount: { increment: 1 },
                crmPushError: 'HubSpot push returned no contact id',
              },
            })
            request.log.error({ parsedLeadId: lead.id, tenantId: tenant.id }, 'Retry HubSpot push failed: no contact id')
            results.push({ tenantId: tenant.id, id: lead.id, success: false, message: 'No contact id returned' })
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown HubSpot push error'
          await prisma.parsedLead.update({
            where: { id: lead.id },
            data: {
              crmPushStatus: 'FAILED',
              crmAttemptCount: { increment: 1 },
              crmPushError: errorMessage,
            },
          })
          request.log.error({ parsedLeadId: lead.id, tenantId: tenant.id, error: errorMessage }, 'Retry HubSpot push error')
          results.push({ tenantId: tenant.id, id: lead.id, success: false, message: errorMessage })
        }
      }
    }

    return { success: true, results }
  } catch (error) {
    request.log.error({ error }, 'Error retrying failed HubSpot pushes')
    return reply.status(500).send({ success: false, message: 'Failed to retry failed leads' })
  }
})

server.get('/dev/pushed-leads', async (request, reply) => {
  request.log.info('Fetching pushed parsed leads')

  try {
    const pushedLeads = await prisma.parsedLead.findMany({
      where: { crmPushed: true },
      orderBy: { createdAt: 'desc' },
    })

    request.log.info({ count: pushedLeads.length }, 'Retrieved pushed parsed leads')
    return { leads: pushedLeads }
  } catch (error) {
    request.log.error({ error }, 'Error fetching pushed leads')
    return reply.status(500).send({ success: false, message: 'Failed to fetch pushed leads' })
  }
})

server.post('/dev/seed-hubspot-token', async (request, reply) => {
  if (process.env.NODE_ENV === 'production') {
    return reply.status(403).send({ success: false, message: 'Not allowed in production' })
  }

  const body = request.body as { tenantId?: string; token?: string }
  const tenantId = body.tenantId?.trim()
  const token = body.token?.trim()

  if (!tenantId || !token) {
    return reply.status(400).send({ success: false, message: 'Missing tenantId or token' })
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) {
    request.log.warn({ tenantId }, 'Tenant not found for HubSpot token seeding')
    return reply.status(404).send({ success: false, message: 'Tenant not found' })
  }

  try {
    server.log.info({ tenantId }, 'Seeding HubSpot token for tenant')

    const crmIntegration = await prisma.crmIntegration.upsert({
      where: {
        tenantId_provider: {
          tenantId,
          provider: 'HUBSPOT',
        },
      },
      update: {
        status: 'CONNECTED',
        encryptedAccessToken: token,
        accountName: 'Dev HubSpot',
      },
      create: {
        tenantId,
        provider: 'HUBSPOT',
        status: 'CONNECTED',
        encryptedAccessToken: token,
        accountName: 'Dev HubSpot',
      },
    })

    server.log.info({ tenantId, crmIntegrationId: crmIntegration.id }, 'Seeded HubSpot token for tenant')

    return { success: true, crmIntegration }
  } catch (error) {
    server.log.error({ error, tenantId }, 'Error seeding HubSpot token for tenant')
    return reply.status(500).send({ success: false, message: 'Failed to seed HubSpot token' })
  }
})

const start = async () => {
  try {
    await prisma.$connect()
    await server.listen({ port: 4000, host: '0.0.0.0' })
    server.log.info('API server listening on http://localhost:4000')
  } catch (error) {
    server.log.error(error)
    process.exit(1)
  }
}

start()
