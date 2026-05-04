import Fastify from 'fastify'
import { google } from 'googleapis'
import { prisma } from '@vinya/db'

const server = Fastify({ logger: true })

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
