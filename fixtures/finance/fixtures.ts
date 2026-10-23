// Invented bank exports for Household Finance tests (Vitest and Playwright). Every amount, balance,
// date and account number here is made up: there is no real household's data in this repository.
// Merchant names are ordinary public businesses so the categorising looks realistic.
//
// The everyday account starts at $2,500.00 on 1 September 2026. File A covers 1–12 September,
// file B 10–18 September (overlapping A by two transactions). Both are NAB-style, newest first,
// with a header row. File B also has two rows that can't be imported (an impossible date and a
// zero amount), which must be reported, never dropped.

const NAB_HEADER = "Date,Amount,Account Number,,Transaction Type,Transaction Details,Balance,Category,Merchant Name,Processed On";
const ACCOUNT = "00-000-000004321";

const nab = (rows: [date: string, amount: string, type: string, details: string, balance: string, category: string, merchant: string][]) =>
    [
        NAB_HEADER,
        ...rows.map(([date, amount, type, details, balance, category, merchant]) =>
            [date, amount, ACCOUNT, "", type, `"${details}"`, balance, category, merchant, date].join(","),
        ),
    ].join("\n") + "\n";

/** 1–12 September, newest first. Two identical coffees on 2 September are two real purchases. */
export const NAB_FILE_A = nab([
    ["12 Sep 26", "-71.40", "EFTPOS DEBIT", "AMPOL FOODARY 3 SURRY HILLS", "4954.16", "Transport", "Ampol"],
    ["10 Sep 26", "-62.10", "EFTPOS DEBIT", "COLES 0456 NEWTOWN", "5025.56", "Groceries", "Coles"],
    ["08 Sep 26", "-500.00", "TRANSFER DEBIT", "ONLINE TRANSFER TO SAVINGS", "5087.66", "Transfers", ""],
    ["05 Sep 26", "-18.99", "VISA DEBIT", "NETFLIX.COM MELBOURNE", "5587.66", "Entertainment", "Netflix"],
    ["02 Sep 26", "-4.50", "EFTPOS DEBIT", "CAFE NERO SYDNEY", "5606.65", "Dining", "Cafe Nero"],
    ["02 Sep 26", "-4.50", "EFTPOS DEBIT", "CAFE NERO SYDNEY", "5611.15", "Dining", "Cafe Nero"],
    ["02 Sep 26", "-84.35", "EFTPOS DEBIT", "WOOLWORTHS 1234 SYDNEY", "5615.65", "Groceries", "Woolworths"],
    ["01 Sep 26", "3200.00", "MISCELLANEOUS CREDIT", "SALARY EXAMPLE EMPLOYER PTY LTD", "5700.00", "Income", ""],
]);

/** 10–18 September: overlaps A on the 10th and 12th, plus two rows that can't be imported. */
export const NAB_FILE_B = nab([
    ["18 Sep 26", "-45.00", "EFTPOS DEBIT", "WOOLWORTHS 5678 PARRAMATTA", "7809.16", "Groceries", "Woolworths"],
    ["31 Feb 26", "-10.00", "EFTPOS DEBIT", "IMPOSSIBLE DATE ROW", "7854.16", "", ""],
    ["15 Sep 26", "3200.00", "MISCELLANEOUS CREDIT", "SALARY EXAMPLE EMPLOYER PTY LTD", "7854.16", "Income", ""],
    ["15 Sep 26", "0.00", "MISCELLANEOUS DEBIT", "CARD VERIFICATION", "4654.16", "", ""],
    ["15 Sep 26", "-300.00", "TRANSFER DEBIT", "ONLINE PAYMENT TO CREDIT CARD", "4654.16", "Transfers", ""],
    ["12 Sep 26", "-71.40", "EFTPOS DEBIT", "AMPOL FOODARY 3 SURRY HILLS", "4954.16", "Transport", "Ampol"],
    ["10 Sep 26", "-62.10", "EFTPOS DEBIT", "COLES 0456 NEWTOWN", "5025.56", "Groceries", "Coles"],
]);

/** The older NAB layout without a header: date, amount, two empty columns, type, details, balance. */
export const NAB_HEADERLESS = [
    "03 Oct 26,-23.80,,,EFTPOS DEBIT,KMART 1122 BROADWAY,1176.20",
    "01 Oct 26,1200.00,,,MISCELLANEOUS CREDIT,TRANSFER FROM EVERYDAY,1200.00",
].join("\n");

/** A savings account: the other side of file A's transfer. */
export const NAB_SAVINGS = nab([["08 Sep 26", "500.00", "TRANSFER CREDIT", "ONLINE TRANSFER FROM EVERYDAY", "10500.00", "Transfers", ""]]);

/** A credit card: a purchase, and the repayment from file B arriving. Money out is negative. */
export const NAB_CREDIT_CARD = nab([
    ["16 Sep 26", "300.00", "PAYMENT", "PAYMENT RECEIVED THANK YOU", "-899.00", "Transfers", ""],
    ["03 Sep 26", "-199.00", "VISA DEBIT", "JB HI-FI BROADWAY", "-1199.00", "Shopping", "JB Hi-Fi"],
]);

/** Westpac-style: separate debit and credit columns, oldest first. */
export const WESTPAC_FILE = [
    "Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance,Categories,Serial",
    "000000001234,01/09/2026,DEPOSIT EXAMPLE PAYROLL,,2100.00,2100.00,INCOME,",
    "000000001234,03/09/2026,ALDI STORES 4421,56.20,,2043.80,GROCERIES,",
].join("\r\n");
