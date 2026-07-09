/**
 * Card Choice component — radio group rendered as image cards.
 * Authors set per-option content in UE field properties:
 *   images       — comma-separated DAM paths, one per enum value in order
 *   descriptions — pipe-separated descriptions, one per enum value in order
 *   badge        — pipe-separated badge labels, one per enum value (leave empty to omit)
 */
export default async function decorate(fieldDiv, fieldJson) {
  const imagesStr = fieldJson.properties?.images || '';
  const images = imagesStr.split(',').map((s) => s.trim());

  const descriptionsStr = fieldJson.properties?.descriptions || '';
  const descriptions = descriptionsStr.split('|').map((s) => s.trim());

  const badgesStr = fieldJson.properties?.badge || '';
  const badges = badgesStr.split('|').map((s) => s.trim());

  const optionDivs = [...fieldDiv.children].filter((el) => el.tagName === 'DIV');

  optionDivs.forEach((div, index) => {
    const label = div.querySelector('label');
    if (!label) return;

    const imageSrc = images[index];
    if (imageSrc) {
      const img = document.createElement('img');
      img.src = imageSrc;
      img.alt = '';
      img.className = 'card-bank-logo';
      label.prepend(img);
    }

    const desc = descriptions[index];
    if (desc) {
      const span = document.createElement('span');
      span.className = 'card-desc';
      span.textContent = desc;
      label.append(span);
    }

    const badge = badges[index];
    if (badge) {
      const badgeEl = document.createElement('span');
      badgeEl.className = 'card-badge';
      badgeEl.textContent = badge;
      div.append(badgeEl);
    }
  });

  return fieldDiv;
}
