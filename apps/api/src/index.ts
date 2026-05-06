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

const syncGmailHistory = async (emailAccountId: string, newHistoryId: string) => {
  server.log.info({ emailAccountId, newHistoryId }, 'Starting Gmail history sync')

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
  })

  if (!emailAccount) {
    throw new Error('EmailAccount not found')
  }

  const previousHistoryId = emailAccount.gmailHistoryId
  if (!previousHistoryId) {
    server.log.info({ emailAccountId, newHistoryId }, 'No previous history ID, storing newHistoryId only')
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { gmailHistoryId: newHistoryId },
    })
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
  server.log.info({ count: uniqueMessageIds.length, messageIds: uniqueMessageIds }, 'Messages found in history records')

  for (const messageId of uniqueMessageIds) {
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
    })

    const payload = messageResponse.data.payload
    const headers = payload?.headers ?? []
    const headerMap = new Map<string, string>()
    for (const header of headers) {
      if (header.name && header.value) {
        headerMap.set(header.name, header.value)
      }
    }

    const { bodyText, bodyHtml } = extractEmailBody(payload)

    await prisma.inboundMessage.upsert({
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
  }

  await prisma.emailAccount.update({
    where: { id: emailAccountId },
    data: { gmailHistoryId: newHistoryId },
  })

  server.log.info({ emailAccountId, newHistoryId }, 'Updated email account history ID after sync')
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

server.get('/health', async () => {
  return { status: 'ok' }
})

server.get('/auth/google', async (_request, reply) => {
  server.log.info('Generating Google OAuth consent screen URL')

  const oauth2Client = createGoogleOAuthClient()
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: OAUTH_SCOPE,
  })

  server.log.info({ authUrl }, 'Redirecting to Google OAuth URL')
  return reply.redirect(authUrl)
})

server.get('/auth/google/callback', async (request, reply) => {
  const query = request.query as { code?: string }
  const code = String(query.code ?? '')

  if (!code) {
    server.log.warn({ query }, 'Missing code in Google OAuth callback')
    return reply.status(400).send({ success: false, message: 'Missing OAuth code' })
  }

  server.log.info({ code: '[REDACTED]' }, 'Received Google OAuth callback code')

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

    server.log.info({ emailAddress }, 'Fetched Gmail profile email address')

    let tenant = await prisma.tenant.findFirst({ where: { name: SEED_TENANT_NAME } })
    if (!tenant) {
      server.log.info({ tenantName: SEED_TENANT_NAME }, 'Seed tenant not found, creating new tenant')
      tenant = await prisma.tenant.create({ data: { name: SEED_TENANT_NAME } })
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
        status: 'CONNECTED',
      },
      create: {
        tenantId: tenant.id,
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
      { tenantId: tenant.id, emailAccountId: emailAccount.id, gmailCredentialId: gmailCredential.id },
      'Saved Gmail credentials for seed tenant',
    )

    return {
      success: true,
      tenantId: tenant.id,
      emailAddress,
      emailAccountId: emailAccount.id,
      gmailCredentialId: gmailCredential.id,
    }
  } catch (error) {
    server.log.error({ error }, 'Error during Gmail OAuth callback processing')
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
  try {
    const body = request.body as { message?: { data?: string } }
    if (!body.message?.data) {
      server.log.warn({ body }, 'Invalid PubSub message format')
      return reply.status(400).send({ success: false, message: 'Invalid message format' })
    }

    const decoded = JSON.parse(
      Buffer.from(body.message.data, 'base64').toString()
    ) as { emailAddress?: string; historyId?: string }

    const emailAddress = decoded.emailAddress
    const historyId = decoded.historyId
    request.log.info({ emailAddress, historyId }, 'Received PubSub event')

    if (!emailAddress || !historyId) {
      request.log.warn({ emailAddress, historyId }, 'PubSub event missing emailAddress or historyId')
      return reply.status(400).send({ success: false, message: 'Missing emailAddress or historyId' })
    }

    const emailAccount = await prisma.emailAccount.findFirst({
      where: {
        provider: 'GMAIL',
        emailAddress,
      },
    })

    if (!emailAccount) {
      request.log.warn({ emailAddress }, 'No connected Gmail EmailAccount found for PubSub event')
      return reply.status(404).send({ success: false, message: 'Email account not found' })
    }

    const syncResult = await syncGmailHistory(emailAccount.id, String(historyId))
    server.log.info({ syncResult }, 'Completed Gmail history sync for PubSub event')

    return reply.status(200).send({ success: true, ...syncResult })
  } catch (error) {
    server.log.error({ error }, 'Error processing PubSub event')
    return reply.status(500).send({ success: false, message: 'Failed to process PubSub event' })
  }
})

server.post('/dev/gmail/watch', async (request, reply) => {
  server.log.info('Registering Gmail watch for connected account')

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
    const watchResponse = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: 'projects/vinya-prod/topics/gmail-events',
      },
    })

    const historyId = watchResponse.data.historyId
    const expiration = watchResponse.data.expiration

    if (historyId && expiration) {
      await prisma.emailAccount.update({
        where: { id: emailAccount.id },
        data: {
          gmailHistoryId: historyId,
          watchExpiration: new Date(parseInt(expiration)),
        },
      })

      server.log.info(
        { emailAccountId: emailAccount.id, historyId, expiration },
        'Gmail watch registered and saved to DB'
      )
    } else {
      server.log.warn({ emailAccountId: emailAccount.id, historyId, expiration }, 'Gmail watch response missing historyId or expiration')
    }

    return {
      success: true,
      emailAccountId: emailAccount.id,
      historyId,
      expiration,
    }
  } catch (error) {
    server.log.error({ error }, 'Error registering Gmail watch')
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

    const crmIntegration = await prisma.crmIntegration.findFirst({
      where: {
        provider: 'HUBSPOT',
        status: 'CONNECTED',
      },
    })

    if (!crmIntegration) {
      request.log.warn('No connected HubSpot CRM integration found')
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

  const body = request.body as { token?: string }
  const token = body.token?.trim()

  if (!token) {
    return reply.status(400).send({ success: false, message: 'Missing token' })
  }

  const tenant = await prisma.tenant.findFirst({
    where: { name: SEED_TENANT_NAME },
  })

  if (!tenant) {
    request.log.warn({ tenantName: SEED_TENANT_NAME }, 'Seed tenant not found')
    return reply.status(404).send({ success: false, message: 'Seed tenant not found' })
  }

  const crmIntegration = await prisma.crmIntegration.upsert({
    where: {
      tenantId_provider: {
        tenantId: tenant.id,
        provider: 'HUBSPOT',
      },
    },
    update: {
      status: 'CONNECTED',
      encryptedAccessToken: token,
      accountName: 'Dev HubSpot',
    },
    create: {
      tenantId: tenant.id,
      provider: 'HUBSPOT',
      status: 'CONNECTED',
      encryptedAccessToken: token,
      accountName: 'Dev HubSpot',
    },
  })

  return { success: true, crmIntegration }
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
