import { expect, test } from '@playwright/test'

/**
 * One end-to-end pass over the venue's real workflow, against the production
 * build: sign in → build the menu → add a kitchen account → take an order →
 * see it in the order list → work it on the kitchen display until completed.
 */
test('login → menu → order → kitchen display', async ({ page }) => {
  // ---- sign in as the seeded admin ----
  await page.goto('/')
  await page.getByLabel('Username').fill('admin')
  await page.getByLabel('Password').fill('playwright123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('link', { name: 'Orders' })).toBeVisible()

  // ---- build a one-product menu ----
  await page.getByRole('link', { name: 'Menu' }).click()
  await page.getByPlaceholder('New category, e.g. Starters').fill('Drinks')
  await page.getByRole('button', { name: 'Add' }).first().click()
  await expect(page.getByRole('cell', { name: 'Drinks' })).toBeVisible()

  await page.getByPlaceholder('Product name').fill('Beer')
  await page.getByPlaceholder('8.50').fill('5')
  await page.getByRole('button', { name: 'Add' }).nth(1).click()
  await expect(page.getByRole('cell', { name: 'Beer', exact: true })).toBeVisible()

  // ---- create a kitchen account: this switches the Kitchen page on ----
  await page.getByRole('link', { name: 'Staff' }).click()
  await page.getByPlaceholder('username', { exact: true }).fill('chef')
  await page.getByPlaceholder('password (8+ chars)').fill('chefpass123')
  await page.getByRole('combobox').last().selectOption('kitchen')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('cell', { name: 'chef' }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Kitchen' })).toBeVisible()

  // ---- take an order ----
  await page.getByRole('link', { name: 'New order' }).click()
  await page.getByRole('button', { name: /Beer/ }).click()
  await page.getByLabel(/Customer/).fill('Mario')
  await page.getByRole('button', { name: 'Send order' }).click()
  await expect(page.getByText(/Order #\d+ sent/)).toBeVisible()

  // ---- the order list shows it ----
  await page.getByRole('link', { name: 'Orders' }).click()
  await expect(page.getByRole('cell', { name: 'Mario' })).toBeVisible()
  await expect(page.getByText('001')).toBeVisible()

  // ---- work it on the kitchen display ----
  await page.getByRole('link', { name: 'Kitchen' }).click()
  await expect(page.getByText('#001')).toBeVisible()

  // The workbench summary counts the pending beer, collapses and re-expands.
  await expect(page.getByRole('button', { name: /To prepare · 1/ })).toBeVisible()
  await expect(page.locator('.kds-todo-item')).toHaveText(/1×\s*Beer/)
  await page.getByRole('button', { name: /To prepare/ }).click()
  await expect(page.locator('.kds-todo-item')).toHaveCount(0)
  await page.getByRole('button', { name: /To prepare/ }).click()
  await expect(page.locator('.kds-todo-item')).toHaveCount(1)

  const item = page.getByRole('button', { name: /1×\s*Beer/ })
  await item.click()
  // Last item done → nothing left to prepare, order moves to Completed.
  await expect(page.locator('.kds-todo')).toHaveCount(0)
  await expect(page.getByText(/Completed · 1/)).toBeVisible()

  // ---- and the waiters' list now flags it ready ----
  await page.getByRole('link', { name: 'Orders' }).click()
  await expect(page.getByText('ready')).toBeVisible()

  // ---- customer self-ordering: switch it on ----
  await page.getByRole('link', { name: 'Settings' }).click()
  // Controlled checkbox: the checked state lands only after the save
  // round-trip, so click (not check) and wait for the hint to confirm.
  const toggle = page.getByLabel(/Customer self-ordering/)
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(page.getByText(/Customers order at:/)).toBeVisible()
  await expect(toggle).toBeChecked()

  // ---- a customer (no login) orders from their phone ----
  const customer = await page.context().newPage()
  await customer.goto('/order')
  await customer.getByRole('button', { name: /Beer/ }).click()
  await customer.getByLabel(/Your name/).fill('Table 9')
  await customer.getByRole('button', { name: /\+/ }).first().click() // 2 people
  await customer.getByRole('button', { name: 'Send order' }).click()

  // ---- the status page shows the pickup number, in preparation ----
  await expect(customer.getByText('Your order number')).toBeVisible()
  await expect(customer.getByText('002')).toBeVisible()
  await expect(customer.getByText('In preparation')).toBeVisible()

  // ---- staff sees it flagged as a customer order to pay, marks it paid ----
  await page.getByRole('link', { name: 'Orders' }).click()
  await expect(page.getByRole('cell', { name: /Table 9/ })).toBeVisible()
  await expect(page.getByText('to pay')).toBeVisible()
  await page.getByRole('button', { name: 'Mark paid' }).click()
  await expect(page.getByText('to pay')).toHaveCount(0)
})
