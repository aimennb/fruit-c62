// =====================================================================
// Outil de mise en forme du texte arabe pour PDFKit.
// PDFKit n'inclut ni le reshaping (ligatures arabes) ni le reordering
// bidirectionnel (Bidi). On utilise `arabic-reshaper` (forme les lettres
// selon leur position) + `bidi` (réordonne visuellement LTR/RTL) pour
// produire une chaîne que PDFKit peut imprimer de gauche à droite.
// =====================================================================
import arabicReshaper from 'arabic-reshaper';
import { Bidi } from 'bidi';

/**
 * Transforme une chaîne arabe (ou mixte) en chaîne prête pour PDFKit :
 * lettres reshapeées + ordre visuel (RTL) correct.
 * Les chaînes ne contenant aucun caractère arabe sont renvoyées telles
 * quelles (pas de reshaping inutile, préserve les chiffres/latin).
 */
export function shapeArabic(text: string): string {
  if (!text) return '';
  // Présence d'un caractère arabe ?
  if (!/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text)) {
    return text;
  }
  const reshaped = arabicReshaper.convertArabic(text);
  const bidi: any = Bidi.from_string(reshaped);
  bidi.reorder_visually();
  return bidi.toString();
}
