import Fastify from 'fastify'
import { prisma } from '@vinya/db'

const server = Fastify({ logger: true })

server.get('/health', async () => {
  return { status: 'ok' }
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
