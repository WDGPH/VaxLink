import { test, expect } from '@playwright/test'

test('homepage renders decision CTAs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /scan vaccine barcodes/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /install extension/i }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /open explorer/i }).first()).toBeVisible()
})

test('extension page shows install and trust sections', async ({ page }) => {
  await page.goto('/extension')
  await expect(page.getByRole('heading', { name: /developer mode install/i })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('heading', { name: /questions clinic teams ask before rollout/i })).toBeVisible()
})

test('explorer page shows guided start and parser UI', async ({ page }) => {
  await page.goto('/explorer')
  await expect(page.getByText(/fetch the nvc bundle/i)).toBeVisible()
  await expect(page.getByRole('heading', { name: /verify source data before trusting the lot match/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /fetch from nvc api/i })).toBeVisible()
})
