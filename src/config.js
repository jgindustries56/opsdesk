'use strict';

/**
 * The white-label layer.
 *
 * Every client deployment runs this same codebase. What makes Rox Jewelers'
 * instance look and behave like Rox Jewelers' own software — and Canwil's like
 * Canwil's — is entirely the environment variables set on that Railway service.
 *
 * Nothing in here should ever be hard-coded to a single client.
 */

const bool = (v, fallback = false) => {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};

const int = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};

const list = (v, fallback = []) => {
  if (!v) return fallback;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
};

const ALL_MODULES = ['contacts', 'intakes', 'jobs', 'invoices', 'payments', 'followups'];

const config = {
  // ---- Identity ---------------------------------------------------------
  companyName: process.env.COMPANY_NAME || 'OpsDesk',
  companyTagline: process.env.COMPANY_TAGLINE || 'Operations at a glance',
  companyEmail: process.env.COMPANY_EMAIL || '',
  companyPhone: process.env.COMPANY_PHONE || '',
  companyAddress: process.env.COMPANY_ADDRESS || '',
  companyWebsite: process.env.COMPANY_WEBSITE || '',
  logoUrl: process.env.LOGO_URL || '',
  faviconEmoji: process.env.FAVICON_EMOJI || '',

  // ---- Look and feel ----------------------------------------------------
  brandPrimary: process.env.BRAND_PRIMARY || '#1f6feb',
  brandAccent: process.env.BRAND_ACCENT || '#0f9d58',
  brandDanger: process.env.BRAND_DANGER || '#d93025',
  brandSurface: process.env.BRAND_SURFACE || '#ffffff',
  brandInk: process.env.BRAND_INK || '#11161d',
  brandRadius: process.env.BRAND_RADIUS || '10px',
  brandFont:
    process.env.BRAND_FONT ||
    "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  theme: (process.env.THEME || 'auto').toLowerCase(), // auto | light | dark

  // ---- Vocabulary -------------------------------------------------------
  // A jeweller has "clients" and "pieces". A textile mill has "accounts" and
  // "orders". A plumber has "customers" and "jobs". Same tables underneath.
  labels: {
    contact: process.env.LABEL_CONTACT || 'Customer',
    contactPlural: process.env.LABEL_CONTACT_PLURAL || 'Customers',
    intake: process.env.LABEL_INTAKE || 'Enquiry',
    intakePlural: process.env.LABEL_INTAKE_PLURAL || 'Enquiries',
    job: process.env.LABEL_JOB || 'Job',
    jobPlural: process.env.LABEL_JOB_PLURAL || 'Jobs',
    invoice: process.env.LABEL_INVOICE || 'Invoice',
    invoicePlural: process.env.LABEL_INVOICE_PLURAL || 'Invoices',
    payment: process.env.LABEL_PAYMENT || 'Payment',
    paymentPlural: process.env.LABEL_PAYMENT_PLURAL || 'Payments',
  },

  // ---- Money ------------------------------------------------------------
  currency: process.env.CURRENCY || 'USD',
  currencyLocale: process.env.CURRENCY_LOCALE || 'en-US',
  taxLabel: process.env.TAX_LABEL || 'Tax',
  defaultTaxRate: Number(process.env.DEFAULT_TAX_RATE || 0), // percent, e.g. 8.875
  invoicePrefix: process.env.INVOICE_PREFIX || 'INV-',
  invoiceStartNumber: int(process.env.INVOICE_START_NUMBER, 1001),
  paymentTermsDays: int(process.env.PAYMENT_TERMS_DAYS, 30),
  paymentTermsText:
    process.env.PAYMENT_TERMS_TEXT || 'Payment due within {{days}} days of invoice date.',

  // ---- Pipeline vocabulary ---------------------------------------------
  intakeChannels: list(process.env.INTAKE_CHANNELS, [
    'Phone call',
    'Email',
    'Walk-in',
    'Website',
    'Referral',
    'Social',
  ]),
  intakeStages: list(process.env.INTAKE_STAGES, [
    'New',
    'Contacted',
    'Quoted',
    'Won',
    'Lost',
  ]),
  jobStages: list(process.env.JOB_STAGES, [
    'Draft',
    'Scheduled',
    'In progress',
    'Blocked',
    'Complete',
    'Cancelled',
  ]),
  paymentMethods: list(process.env.PAYMENT_METHODS, [
    'Card',
    'Cash',
    'Bank transfer',
    'Cheque',
    'Other',
  ]),

  // ---- Follow-up rules --------------------------------------------------
  // The whole point of the product: nothing quietly falls through the cracks.
  followUp: {
    intakeStaleDays: int(process.env.FOLLOWUP_INTAKE_DAYS, 3),
    jobStaleDays: int(process.env.FOLLOWUP_JOB_DAYS, 7),
    draftInvoiceDays: int(process.env.FOLLOWUP_DRAFT_INVOICE_DAYS, 2),
    uninvoicedJobDays: int(process.env.FOLLOWUP_UNINVOICED_DAYS, 2),
    overdueGraceDays: int(process.env.FOLLOWUP_OVERDUE_GRACE_DAYS, 0),
  },

  // ---- Modules ----------------------------------------------------------
  // Turn off what a client doesn't need. A retailer with no field work can
  // drop "jobs"; a pure services business can drop stock-style modules later.
  modules: (() => {
    const enabled = list(process.env.MODULES, ALL_MODULES);
    return ALL_MODULES.reduce((acc, m) => {
      acc[m] = enabled.includes(m);
      return acc;
    }, {});
  })(),

  // ---- Runtime ----------------------------------------------------------
  env: process.env.NODE_ENV || 'development',
  // Which deployment this is. Shows a visible banner on anything not "production"
  // so you never demo staging data to a client by accident.
  deployEnv: (process.env.DEPLOY_ENV || process.env.RAILWAY_ENVIRONMENT_NAME || 'local').toLowerCase(),
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || '',
  sqlitePath: process.env.SQLITE_PATH || './data/opsdesk.db',
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionDays: int(process.env.SESSION_DAYS, 14),
  readOnly: bool(process.env.READ_ONLY, false),
  demoMode: bool(process.env.DEMO_MODE, false),
  timezone: process.env.TZ_DISPLAY || 'America/New_York',
};

config.isProduction = config.deployEnv === 'production';

/** The subset that is safe to hand to the browser. */
config.publicConfig = () => ({
  companyName: config.companyName,
  companyTagline: config.companyTagline,
  companyEmail: config.companyEmail,
  companyPhone: config.companyPhone,
  companyAddress: config.companyAddress,
  companyWebsite: config.companyWebsite,
  logoUrl: config.logoUrl,
  faviconEmoji: config.faviconEmoji,
  brand: {
    primary: config.brandPrimary,
    accent: config.brandAccent,
    danger: config.brandDanger,
    surface: config.brandSurface,
    ink: config.brandInk,
    radius: config.brandRadius,
    font: config.brandFont,
    theme: config.theme,
  },
  labels: config.labels,
  currency: config.currency,
  currencyLocale: config.currencyLocale,
  taxLabel: config.taxLabel,
  defaultTaxRate: config.defaultTaxRate,
  paymentTermsDays: config.paymentTermsDays,
  intakeChannels: config.intakeChannels,
  intakeStages: config.intakeStages,
  jobStages: config.jobStages,
  paymentMethods: config.paymentMethods,
  modules: config.modules,
  followUp: config.followUp,
  deployEnv: config.deployEnv,
  isProduction: config.isProduction,
  readOnly: config.readOnly,
  demoMode: config.demoMode,
});

module.exports = config;
module.exports.ALL_MODULES = ALL_MODULES;
