export const metadata = {
  title: 'Vinya Web',
  description: 'Next.js frontend for Vinya SaaS platform'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
