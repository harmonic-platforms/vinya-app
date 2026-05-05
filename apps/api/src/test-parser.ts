// Test cases for parseLeadFromMessage function
// To run: npx tsx test-parser.ts

function extractLabeledField(text: string, label: string): string | null {
  const regex = new RegExp(`${label}:\\s*([^\\n\\r]+?)(?=\\s+\\w+:\\s*|$)`, "i");
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
}

// Import the function (assuming it's exported, but since it's not, we'll copy it here for testing)
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
  const genericEmail = rawText.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i)?.[0] ?? null;
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

  // Message fallback to snippet
  const messageText = snippet || rawText

  return {
    source,
    name,
    email,
    phone,
    message: messageText,
    parseStatus: 'SUCCESS' as const,
  }
}

// Test case 0: Exact user example with bodyText
const test0 = parseLeadFromMessage({
  from: null,
  subject: null,
  snippet: null,
  bodyText: 'Lead Name: Michael Roitman Phone Number: 3035881986'
})
console.log('Test 0 (exact user example with bodyText):', test0)
// Expected: source: 'unknown', name: 'Michael Roitman', phone: '3035881986', email: null

// Test case 1: Mortgage lead provider style with full body
const test1 = parseLeadFromMessage({
  from: 'leadprovider@example.com',
  subject: 'New Lead',
  snippet: null,
  bodyText: `Lead ID: 12345
Lead Information:
Lead Name: Michael Roitman
Phone Number: 3035881986
Email: michael@example.com
Credit Rating: 750
Property County: Denver
Property State: CO
Property Zip: 80202
Property Value: 500000
Served in Military: No
Bankruptcy: No
Loan Type: Refinance
Military Branch: N/A
Has Real Estate Agent: Yes
Down Payment Percent: 20
Property Type: Single Family
Property Use: Primary Residence
Loan Product: 30 Year Fixed
Employment Status: Employed
Gross Income: 120000
First Time purchase: No
Living Situation: Own
Purchase Status: Pre-approval
Down Payment: 100000
Property City: Denver`
})
console.log('Test 1 (mortgage lead provider with full body):', test1)
// Expected: source: 'mortgage_lead_provider', name: 'Michael Roitman', phone: '3035881986', email: 'michael@example.com', and all other fields extracted

// Test case 2: Realtor.com
const test2 = parseLeadFromMessage({
  from: 'noreply@realtor.com',
  subject: 'John Doe is interested',
  snippet: 'John Doe called about property. Phone: (555) 123-4567',
  bodyText: null
})
console.log('Test 2 (realtor):', test2)
// Expected: source: 'realtor', name: 'John Doe', phone: '(555) 123-4567'

// Test case 3: Generic fallback
const test3 = parseLeadFromMessage({
  from: 'unknown@example.com',
  subject: 'Jane Smith Inquiry',
  snippet: 'Jane Smith wants info. Email: jane@example.com Phone: 555-987-6543',
  bodyText: null
})
console.log('Test 3 (generic):', test3)
// Expected: source: 'unknown', name: 'Jane Smith', phone: '555-987-6543', email: 'jane@example.com'