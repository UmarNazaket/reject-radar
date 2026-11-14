/** A legal page: its English title and sections. */
export interface LegalText {
  title: string;
  /** True until the owner's final text replaces the draft; the page then says it is not yet in force. */
  draft: boolean;
  sections: { heading: string; paragraphs: string[] }[];
}

export type LegalPage = 'terms' | 'privacy' | 'refunds' | 'disclaimer';

const CONTACT = 'Contact: support@umarnazaket.com.';

export const LEGAL_TEXT: Record<LegalPage, LegalText> = {
  terms: {
    title: 'Terms of service',
    draft: false,
    sections: [
      {
        heading: 'Who we are',
        paragraphs: ['RejectLens is operated by Umar Nazaket, a sole trader based in Pakistan.', CONTACT],
      },
      {
        heading: 'The service',
        paragraphs: [
          'RejectLens shows public food-safety records published by government agencies, such as US FDA import refusals and Import Alerts, EU RASFF notifications, UK border notifications, Australian failed import tests and EU pesticide limits, and links them to the firms they name.',
          "Records are shown as the agencies publish them, each with a link to the agency's own record. RejectLens does not score, certify or interpret them.",
        ],
      },
      {
        heading: 'Source data',
        paragraphs: [
          "Agencies can publish late, change or withdraw records, and linking a record to a firm can be wrong. Check the agency's own record before you act on it. You can report a problem from any firm profile.",
        ],
      },
      {
        heading: 'Accounts',
        paragraphs: [
          'Keep your password and API keys secret. You are responsible for what is done with your account. An account owner manages its members and its plan.',
        ],
      },
      {
        heading: 'Plans and payment',
        paragraphs: [
          'Paid plans are sold through Paddle, our reseller and merchant of record, which handles payment, tax and invoices under its own buyer terms.',
          'A subscription renews every month or year until it is cancelled. An owner can cancel it at any time in Settings, Billing; it then ends at the end of the period already paid. The limits of each plan are on the pricing page.',
        ],
      },
      {
        heading: 'Fair use',
        paragraphs: [
          'Use the service within your plan and its rate limits. Do not copy the data in bulk to resell it, share an account outside your organisation, or try to get around the limits.',
        ],
      },
      {
        heading: 'Suspension',
        paragraphs: ['We may deactivate an account that breaks these terms, after telling its owner when we can.'],
      },
      {
        heading: 'Liability',
        paragraphs: [
          'RejectLens is provided as it is. We work to keep it available and its records and links correct, but we do not promise that it is uninterrupted, complete or free of errors.',
          'As far as the law allows, we are not liable for indirect or consequential loss arising from your use of the service, such as lost profit, lost business or a rejected shipment, and our total liability for any claim is limited to what you paid us in the 12 months before it.',
          'Nothing in these terms limits a liability that the law does not allow to be limited.',
        ],
      },
      {
        heading: 'Changes',
        paragraphs: ['We email account owners before a material change to these terms takes effect.'],
      },
      { heading: 'Governing law', paragraphs: ['These terms are governed by the laws of Pakistan, and the courts of Pakistan decide any dispute about them.'] },
    ],
  },
  privacy: {
    title: 'Privacy policy',
    draft: false,
    sections: [
      {
        heading: 'Who is responsible',
        paragraphs: ['Umar Nazaket, a sole trader based in Pakistan, is responsible for your personal data.', CONTACT],
      },
      {
        heading: 'What we collect',
        paragraphs: [
          'Your account: name, email address, company name, language and a hash of your password.',
          'What you do in the service: the firms you open, your watchlist, bulk screening files, API calls, and an audit log of changes made by staff.',
          'Billing: Paddle processes your payment. We receive your plan, the state of your subscription and a customer id; your card details never reach us.',
          'Security: the IP address and browser of requests, kept in our logs to stop abuse.',
        ],
      },
      {
        heading: 'Why we use it',
        paragraphs: ['To run the service, to send the alerts and account emails you ask for, to bill your plan, and to keep accounts secure.'],
      },
      {
        heading: 'Cookies',
        paragraphs: ['We use only the cookies that keep you signed in and protect forms against forgery. There are no analytics or advertising cookies.'],
      },
      {
        heading: 'Who processes it for us',
        paragraphs: [
          'Neon (database, Singapore), Render (API hosting), Cloudflare (web hosting), Resend (email) and Paddle (billing). The plain-English summaries of FDA Import Alerts are written with Anthropic from public alert text only; no personal data is sent.',
        ],
      },
      {
        heading: 'How long we keep it',
        paragraphs: [
          'Your account data, for as long as the account exists. Bulk screening rows are deleted 30 days after the job finishes, and email delivery records after 90 days.',
          'When you ask us to delete your account, we delete it and its personal data within 30 days, except records we must keep for tax or legal reasons. The nightly backups that still hold it expire within a further 30 days.',
        ],
      },
      {
        heading: 'Public records',
        paragraphs: ["Personal details that an agency publishes, such as the officials named in RASFF notification details, are never stored."],
      },
      {
        heading: 'Your rights',
        paragraphs: ['You can ask to see, correct, export or delete your personal data.', CONTACT],
      },
    ],
  },
  refunds: {
    title: 'Refund policy',
    draft: false,
    sections: [
      {
        heading: 'Payments',
        paragraphs: ['Paddle, our reseller and merchant of record, takes every payment and issues every refund.'],
      },
      {
        heading: 'Refunds',
        paragraphs: [
          'You can get a full refund of any charge within 14 days of it, for any reason. Paddle returns the money to the payment method you used.',
          'After 14 days a charge is not refunded, but you can cancel at any time to stop the next renewal.',
        ],
      },
      {
        heading: 'How to ask',
        paragraphs: ['Use the link in your Paddle receipt, or write to us.', CONTACT],
      },
      {
        heading: 'Cancelling',
        paragraphs: ['Cancelling stops the next renewal. Your plan stays active until the end of the period already paid.'],
      },
    ],
  },
  disclaimer: {
    title: 'Disclaimer',
    draft: false,
    sections: [
      {
        heading: 'Facts as published',
        paragraphs: [
          "RejectLens shows records that government agencies publish: the US FDA, the European Commission (RASFF and the EU Pesticides Database), the UK Food Standards Agency and the Australian Department of Agriculture. Each record links to the agency's own notice. RejectLens does not add to, score or interpret them.",
        ],
      },
      {
        heading: 'Not a risk score',
        paragraphs: [
          "A record says that an agency took an action on a shipment or a firm on a date. It does not say that the firm's other shipments are unsafe, and it is not a rating or a prediction. A firm with no records may simply not export to the countries covered.",
        ],
      },
      {
        heading: 'Delays and errors',
        paragraphs: [
          "Agencies publish on their own schedules and sometimes change or withdraw records, and RejectLens reads each source daily, weekly or monthly, so a record can appear here late. Records are linked to firms by matching names and numbers, which can be wrong. Check the agency's own record before you act on it.",
        ],
      },
      {
        heading: 'Names as published',
        paragraphs: ['Some agencies publish sole traders under their own names. RejectLens shows those names exactly as published and adds nothing about the person.'],
      },
      {
        heading: 'Corrections',
        paragraphs: [
          'If a record is linked to the wrong firm, or a firm is described wrongly, report it from the firm profile. RejectLens corrects its own links; only the agency that published a record can change the record itself.',
          CONTACT,
        ],
      },
    ],
  },
};
