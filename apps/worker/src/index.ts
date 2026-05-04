import { prisma } from '@vinya/db'

const start = async () => {
  try {
    await prisma.$connect()
    console.log('worker started')
    process.stdin.resume()
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

start()
