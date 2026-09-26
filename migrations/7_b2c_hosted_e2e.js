/**
 * Wave 5 — B2C hosted e2e.
 *
 * Links WatchTargets to curated ProductOffers (B2C catalog) so change
 * emails can attach an affiliate CTA stub (/r/:id) + disclosure.
 * product_offer_id is nullable — B2B watches stay unlinked.
 */

exports.up = (pgm) => {
  pgm.addColumn('watch_targets', {
    product_offer_id: {
      type: 'text',
      references: 'product_offers(id)',
    },
  });
  pgm.createIndex('watch_targets', 'product_offer_id');
};

exports.down = (pgm) => {
  pgm.dropIndex('watch_targets', 'product_offer_id');
  pgm.dropColumn('watch_targets', 'product_offer_id');
};
