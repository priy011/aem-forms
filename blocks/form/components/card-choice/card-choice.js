/**
 * Card Choice component — radio group rendered as image cards.
 * Authors set per-option image paths in the "Card Images" property in UE
 * (comma-separated DAM paths, one per enum value in order).
 */
export default async function decorate(fieldDiv, fieldJson) {
  const imagesStr = fieldJson.properties?.images || '';
  const images = imagesStr.split(',').map((s) => s.trim()).filter(Boolean);

  if (images.length === 0) return fieldDiv;

  // Direct <div> children of the fieldset are the radio option wrappers
  // (field-wrapper classes are stripped by createRadioOrCheckboxUsingEnum)
  const optionDivs = [...fieldDiv.children].filter((el) => el.tagName === 'DIV');

  optionDivs.forEach((div, index) => {
    const imageSrc = images[index];
    if (!imageSrc) return;

    const label = div.querySelector('label');
    if (!label) return;

    const img = document.createElement('img');
    img.src = imageSrc;
    img.alt = '';
    img.className = 'card-bank-logo';
    label.prepend(img);
  });

  return fieldDiv;
}
