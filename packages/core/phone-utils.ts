export function normalizePhoneNumber(phone: string): string {
  return phone.replace(/[^\d+]/g, "").trim();
}
