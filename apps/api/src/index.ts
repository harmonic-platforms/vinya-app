import Fastify from 'fastify'
import { google } from 'googleapis'
import { Prisma } from '@prisma/client'
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

    await prisma.inboundMessage.upsert({
      where: { gmailMessageId: messageId },
      update: {
        threadId: messageResponse.data.threadId ?? '',
        from: headerMap.get('From') ?? null,
        subject: headerMap.get('Subject') ?? null,
        snippet: messageResponse.data.snippet ?? null,
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

      messages.push({
        id: messageResponse.data.id ?? messageMeta.id,
        from: headerMap.get('From') ?? null,
        subject: headerMap.get('Subject') ?? null,
        date: headerMap.get('Date') ?? null,
        snippet: messageResponse.data.snippet ?? null,
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
