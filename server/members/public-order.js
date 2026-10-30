// Earlier publications could expose the Stripe checkout ID as their public ID.
// Once exposed, that receipt can no longer be trusted as proof of ownership.
async function requiresMemberAccess(order, findPublicationForOrder, receiptId = order?.id, companyId = order?.ticker) {
  if (order?.adminCopy) return false;
  if (order?.memberOnly) return true;
  if (!String(receiptId || '').startsWith('cs_') || order?.lastPublishedJobId) return false;
  if (!process.env.MEMBERS_TABLE) return true;
  const publication = await findPublicationForOrder(receiptId, companyId);
  return Boolean(publication && ['published', 'takendown'].includes(publication.status));
}

module.exports = { requiresMemberAccess };
