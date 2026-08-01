// Déclarations de modules pour paquets sans types (arabic-reshaper, bidi).
declare module 'arabic-reshaper' {
  /** Reforme les caractères arabes selon leur position (contexte). */
  export function convertArabic(text: string): string;
  export function convertArabicBack(text: string): string;
  const _default: { convertArabic: typeof convertArabic; convertArabicBack: typeof convertArabicBack };
  export default _default;
}

declare module 'bidi' {
  export interface BidiInstance {
    string_arr: number[];
    types: string[];
    levels: number[];
    reorder_visually(): void;
    toString(): string;
  }
  export interface BidiStatic {
    from_string(str: string, options?: any): BidiInstance;
    from_type_array(types: string[], options?: any): BidiInstance;
    bidi_class_for(code_point: number): string | null;
  }
  const Bidi: BidiStatic;
  export { Bidi };
  export default Bidi;
}
