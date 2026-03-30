import { test, expect } from '@playwright/test'

test('homepage renders decision CTAs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /scan vaccine barcodes/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /install extension/i }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /view extension/i }).first()).toBeVisible()
})

test('extension page shows install and trust sections', async ({ page }) => {
  await page.goto('/extension')
  await expect(page.getByRole('heading', { name: /developer mode install/i })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('heading', { name: /questions clinic teams ask before rollout/i })).toBeVisible()
})
