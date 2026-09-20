/** All header nav options live behind a single "Menu" dropdown (see
 * Header.jsx) — opens it so callers can then find/click a link inside. */
export async function openMenu(page) {
  await page.getByRole('button', { name: /Menu/ }).click();
}
