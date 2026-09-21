/**
 * Native DOM controls for the hidden laboratory (§2.1). No framework, no styling system.
 *
 * These builders are only invoked from `lab/lab.ts` while the panel is actually mounted, which
 * is what keeps presentation mode free of UI nodes (AC.15).
 */

export interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** Formats the numeric readout (values are often ~0.0001). */
  format?: (value: number) => string;
  onInput(value: number): void;
}

export interface SliderHandle {
  row: HTMLDivElement;
  /** Current slider value (the readout the user sees). */
  readonly value: number;
  setValue(value: number): void;
}

export function createSection(parent: HTMLElement, title: string): HTMLDivElement {
  const heading = document.createElement('h2');
  heading.textContent = title;
  const section = document.createElement('div');
  section.appendChild(heading);
  parent.appendChild(section);
  return section;
}

export function createSlider(parent: HTMLElement, spec: SliderSpec): SliderHandle {
  const row = document.createElement('div');
  row.className = 'lab-row';

  const label = document.createElement('label');
  label.textContent = spec.label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);
  input.dataset.role = 'lab-control';

  const value = document.createElement('span');
  value.className = 'value';
  const format = spec.format ?? ((v: number) => v.toFixed(4));
  value.textContent = format(spec.value);
  let current = spec.value;

  input.addEventListener('input', () => {
    const numeric = Number(input.value);
    current = numeric;
    value.textContent = format(numeric);
    spec.onInput(numeric);
  });

  row.append(label, input, value);
  parent.appendChild(row);

  return {
    row,
    get value(): number {
      return current;
    },
    setValue(next: number): void {
      current = next;
      input.value = String(next);
      value.textContent = format(next);
    },
  };
}

export function createButton(parent: HTMLElement, caption: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = caption;
  button.dataset.role = 'lab-control';
  button.addEventListener('click', onClick);
  const row = document.createElement('div');
  row.className = 'lab-row';
  row.appendChild(button);
  parent.appendChild(row);
  return button;
}

export function createReadout(parent: HTMLElement): { element: HTMLPreElement; set(text: string): void } {
  const element = document.createElement('pre');
  parent.appendChild(element);
  return {
    element,
    set(text: string): void {
      element.textContent = text;
    },
  };
}

/** An updatable text element (no input), for readouts that are not a full status block. */
export interface TextHandle {
  element: HTMLDivElement;
  set(text: string): void;
}

export function createText(parent: HTMLElement, className: string, text = ''): TextHandle {
  const element = document.createElement('div');
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return {
    element,
    set(next: string): void {
      element.textContent = next;
    },
  };
}

/** A small explanatory line under a control (laboratory only). */
export function createHelp(parent: HTMLElement, text: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'lab-help';
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export function createToggle(
  parent: HTMLElement,
  caption: string,
  initial: boolean,
  onChange: (value: boolean) => void,
): HTMLButtonElement {
  const button = createButton(parent, `${caption}: ${initial ? 'on' : 'off'}`, () => {
    initial = !initial;
    button.textContent = `${caption}: ${initial ? 'on' : 'off'}`;
    onChange(initial);
  });
  return button;
}
