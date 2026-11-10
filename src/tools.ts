import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { RequestOptions, Sb1Client } from './sparebank1/client.js';

const MAX_RESULT_CHARS = 200_000;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected yyyy-MM-dd');
const accountNumber = z
  .string()
  .transform((v) => v.replace(/[\s.]/g, ''))
  .pipe(z.string().regex(/^\d{11}$/, 'expected an 11 digit account number'));
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'expected a positive decimal amount with a dot, like "1250.50"')
  .describe('Amount as a decimal string with a dot as separator, e.g. "1250.50".');
const accountKey = z
  .string()
  .min(1)
  .describe('Account key ("key") from sb1_list_accounts. This is not the account number.');
const transactionSource = z
  .enum(['RECENT', 'HISTORIC', 'ALL'])
  .optional()
  .describe('RECENT = not yet booked / latest, HISTORIC = booked history, ALL = both.');

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const MOVES_MONEY: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

const seg = encodeURIComponent;

function result(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return { content: [{ type: 'text', text }] };
  return {
    content: [
      {
        type: 'text',
        text:
          `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Truncated: the response was ${text.length} characters. ` +
          'Narrow the request with a shorter date range, fewer accounts or a lower rowLimit.]',
      },
    ],
  };
}

export interface ToolOptions {
  enableTransfers: boolean;
}

export function createMcpServer(client: Sb1Client, options: ToolOptions): McpServer {
  const server = new McpServer(
    { name: 'sparebank1', version: '0.1.0' },
    {
      instructions:
        'Read access to the owner\'s SpareBank 1 accounts, transactions and securities. ' +
        'Start with sb1_list_accounts: most other tools need the account "key" it returns, not the account number. ' +
        'Amounts are in the account currency (normally NOK). Transaction ids are not stable between calls.',
    },
  );

  /** Registers a tool whose handler is a single API call; errors become tool errors the model can read. */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    spec: { title: string; description: string; input: Shape; annotations?: ToolAnnotations },
    call: (args: z.infer<z.ZodObject<Shape>>) => [path: string, options?: RequestOptions],
  ): void {
    server.registerTool(
      name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.input,
        annotations: spec.annotations ?? READ,
      },
      (async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
        try {
          const [path, requestOptions] = call(args);
          return result(await client.request(path, requestOptions));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      }) as never,
    );
  }

  // --- Accounts: /personal/banking/accounts (v5) -------------------------------------------

  tool(
    'sb1_list_accounts',
    {
      title: 'List accounts',
      description:
        'Lists the accounts the user owns or has a role on, with balance, available balance, account number, ' +
        'owner and the account "key" used by the other tools. Credit cards and pension agreements can be ' +
        'included, but their keys do not work with the other account tools.',
      input: {
        includeNokAccounts: z.boolean().optional().describe('Default true.'),
        includeCurrencyAccounts: z.boolean().optional().describe('Default true.'),
        includeBsuAccounts: z.boolean().optional().describe('Default true.'),
        includeCreditCardAccounts: z.boolean().optional().describe('Default false.'),
        includeAskAccounts: z.boolean().optional().describe('Aksjesparekonto. Default false.'),
        includePensionAccounts: z.boolean().optional().describe('Default false.'),
      },
    },
    (query) => ['/personal/banking/accounts', { query, accept: 5 }],
  );

  tool(
    'sb1_get_account',
    {
      title: 'Get account',
      description: 'Gets a single deposit account by its key.',
      input: { accountKey },
    },
    (a) => [`/personal/banking/accounts/${seg(a.accountKey)}`, { accept: 5 }],
  );

  tool(
    'sb1_get_account_details',
    {
      title: 'Get account details',
      description: 'Gets withdrawal, interest, credit and sharing details for a deposit account.',
      input: { accountKey },
    },
    (a) => [`/personal/banking/accounts/${seg(a.accountKey)}/details`, { accept: 5 }],
  );

  tool(
    'sb1_get_account_keys',
    {
      title: 'Look up account keys',
      description: 'Translates account numbers into the account keys used by the other tools.',
      input: { accountNumbers: z.array(accountNumber).min(1).describe('11 digit account numbers.') },
    },
    (a) => ['/personal/banking/accounts/keys', { query: { accountNumber: a.accountNumbers }, accept: 5 }],
  );

  tool(
    'sb1_get_account_balance',
    {
      title: 'Get account balance',
      description: 'Gets the current balance for one account number.',
      input: { accountNumber },
    },
    (a) => ['/personal/banking/accounts/balance', { method: 'POST', body: a, accept: 5 }],
  );

  tool(
    'sb1_list_child_accounts',
    {
      title: 'List a child\'s accounts',
      description: 'Lists the accounts belonging to one of the user\'s children.',
      input: { childId: z.string().min(1).describe('The child\'s id.') },
    },
    (a) => [`/personal/banking/accounts/child/${seg(a.childId)}`, { accept: 5 }],
  );

  // --- Transactions: /personal/banking/transactions (v1) -----------------------------------

  const transactionFilter = {
    accountKeys: z.array(accountKey).min(1).describe('Keys of the accounts to read transactions from.'),
    fromDate: date.optional().describe('First date, yyyy-MM-dd, Norwegian time.'),
    toDate: date.optional().describe('Last date, yyyy-MM-dd, Norwegian time.'),
    rowLimit: z.number().int().min(1).max(10_000).optional().describe('Maximum number of transactions.'),
    source: transactionSource,
  };

  tool(
    'sb1_list_transactions',
    {
      title: 'List transactions',
      description:
        'Lists transactions for one or more accounts, optionally limited to a date range. ' +
        'Always give a date range or rowLimit; a full history can be very large.',
      input: transactionFilter,
    },
    ({ accountKeys, ...rest }) => ['/personal/banking/transactions', { query: { accountKey: accountKeys, ...rest } }],
  );

  tool(
    'sb1_list_classified_transactions',
    {
      title: 'List categorised transactions',
      description:
        'Like sb1_list_transactions, but each transaction also carries the bank\'s spending category. ' +
        'Use this for budgets and spending analysis.',
      input: {
        ...transactionFilter,
        enrichWithMerchantLogo: z
          .boolean()
          .optional()
          .describe('Adds merchant name/logo for the last 430 days. Slower.'),
      },
    },
    ({ accountKeys, ...rest }) => [
      '/personal/banking/transactions/classified',
      { query: { accountKey: accountKeys, ...rest } },
    ],
  );

  const transactionId = z
    .string()
    .min(1)
    .describe('Transaction "id" from a transaction list. Ids change between sessions, so list first.');

  tool(
    'sb1_get_transaction_details',
    {
      title: 'Get transaction details',
      description: 'Gets the details of one transaction.',
      input: { transactionId },
    },
    (a) => [`/personal/banking/transactions/${seg(a.transactionId)}/details`],
  );

  tool(
    'sb1_get_classified_transaction_details',
    {
      title: 'Get categorised transaction details',
      description: 'Gets the details of one transaction, including its spending category.',
      input: {
        transactionId,
        enrichWithMerchantData: z.boolean().optional().describe('Adds merchant name, logo and address. Slower.'),
      },
    },
    ({ transactionId: id, ...query }) => [`/personal/banking/transactions/${seg(id)}/details/classified`, { query }],
  );

  tool(
    'sb1_export_transactions_csv',
    {
      title: 'Export transactions as CSV',
      description: 'Exports booked transactions for one account and period as CSV text.',
      input: {
        accountKey,
        fromDate: date,
        toDate: date,
        fields: z
          .array(
            z.enum([
              'DATE',
              'DESCRIPTION',
              'INTEREST_DATE',
              'IN',
              'OUT',
              'TO_ACCOUNT',
              'FROM_ACCOUNT',
              'CATEGORY',
              'SUBCATEGORY',
            ]),
          )
          .optional()
          .describe('Columns to include. Default is everything except CATEGORY and SUBCATEGORY.'),
      },
    },
    (query) => ['/personal/banking/transactions/export', { query, accept: 'application/csv;charset=UTF-8' }],
  );

  // --- Securities: /personal/banking/securities (v1) ---------------------------------------

  const securitiesViews = {
    holdings: '',
    overview: '/oversikt',
    including_disposed: '/including-disposed',
    share_savings_accounts: '/share-savings-accounts',
    savings_summary: '/widget/savings',
    ask_savings_summary: '/widget/savings/ask',
  } as const;

  tool(
    'sb1_get_securities',
    {
      title: 'Get funds and shares',
      description:
        'Gets the user\'s securities. Views: holdings = all securities and portfolios; overview = fund savings ' +
        'and aksjesparekonto (ASK) with totals; including_disposed = also portfolios the user disposes for ' +
        'others; share_savings_accounts = all ASK accounts with cost basis; savings_summary / ' +
        'ask_savings_summary = compact totals.',
      input: {
        view: z
          .enum(Object.keys(securitiesViews) as [keyof typeof securitiesViews, ...(keyof typeof securitiesViews)[]])
          .default('overview'),
      },
    },
    (a) => [`/personal/banking/securities${securitiesViews[a.view] || '/'}`],
  );

  // --- Common APIs ------------------------------------------------------------------------

  tool(
    'sb1_list_financial_institutions',
    {
      title: 'List SpareBank 1 banks',
      description: 'Lists the financial institutions in the SpareBank 1 alliance.',
      input: {
        kind: z
          .enum(['all', 'banks', 'domainDisplayNames'])
          .default('banks')
          .describe('all = every institution, banks = only banks, domainDisplayNames = display names per domain.'),
      },
    },
    (a) => [`/common/financial-institutions/${a.kind}`],
  );

  tool(
    'sb1_verify_account_owner',
    {
      title: 'Verify account owner',
      description:
        'Checks whether a Norwegian account number is owned by a given person or organisation. It only confirms ' +
        'or denies; it cannot find who owns an account. Give exactly one of nationalIdentityNumber and ' +
        'organizationNumber.',
      input: {
        accountNumber,
        nationalIdentityNumber: z
          .string()
          .regex(/^\d{11}$/)
          .optional()
          .describe('11 digit fødselsnummer, for a person.'),
        organizationNumber: z
          .string()
          .regex(/^\d{9}$/)
          .optional()
          .describe('9 digit organisation number, for a company.'),
      },
    },
    (a) => {
      if ((a.nationalIdentityNumber === undefined) === (a.organizationNumber === undefined)) {
        throw new Error('Give exactly one of nationalIdentityNumber and organizationNumber.');
      }
      return a.nationalIdentityNumber !== undefined
        ? [
            '/common/account-owner/verify/personal',
            { method: 'POST', body: { ssn: a.nationalIdentityNumber, accountNumber: a.accountNumber } },
          ]
        : [
            '/common/account-owner/verify/organization',
            {
              method: 'POST',
              body: { organizationNumber: a.organizationNumber, accountNumber: a.accountNumber },
            },
          ];
    },
  );

  tool(
    'sb1_hello_world',
    {
      title: 'Test the connection',
      description: 'Calls the SpareBank 1 "Hello World" API. Use it to check that the bank connection works.',
      input: {},
    },
    () => ['/common/helloworld'],
  );

  // --- Transfers: /personal/banking/transfer (v1). Off unless SB1_ENABLE_TRANSFERS=true. ---

  if (options.enableTransfers) {
    const dueDate = date.optional().describe('Due date, yyyy-MM-dd. Defaults to today.');
    const fromAccount = accountNumber.describe('Account number the money is taken from.');
    const confirm =
      ' This moves real money and cannot be undone from here: confirm amount and accounts with the user first.';

    tool(
      'sb1_transfer_between_accounts',
      {
        title: 'Transfer between own accounts',
        description: 'Transfers money between two accounts the user has access to.' + confirm,
        annotations: MOVES_MONEY,
        input: {
          fromAccount,
          toAccount: accountNumber.describe('Account number that receives the money.'),
          amount,
          message: z.string().max(40).optional().describe('Message, at most 40 characters.'),
          dueDate,
          currencyCode: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional()
            .describe('Defaults to the currency of the from-account.'),
        },
      },
      (body) => ['/personal/banking/transfer/debit', { method: 'POST', body }],
    );

    tool(
      'sb1_transfer_to_credit_card',
      {
        title: 'Pay down credit card',
        description:
          'Transfers money to one of the user\'s credit card accounts. The card balance may not update before ' +
          'the next business day.' +
          confirm,
        annotations: MOVES_MONEY,
        input: {
          fromAccount,
          creditCardAccountId: z
            .string()
            .min(1)
            .describe('"creditCardAccountID" from sb1_list_accounts with includeCreditCardAccounts.'),
          amount,
          dueDate,
        },
      },
      (body) => ['/personal/banking/transfer/creditcard/transferTo', { method: 'POST', body }],
    );

    tool(
      'sb1_transfer_to_pension',
      {
        title: 'Transfer to pension agreement',
        description: 'Transfers money to one of the user\'s pension agreements.' + confirm,
        annotations: MOVES_MONEY,
        input: {
          fromAccount,
          policyNumber: z.string().min(1).describe('Policy number (polisenummer / avtalenummer).'),
          amount,
          dueDate,
        },
      },
      (body) => ['/personal/banking/transfer/pension', { method: 'POST', body }],
    );
  }

  return server;
}
