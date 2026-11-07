import { createContext, useContext } from 'react';
import { SLICER_TEXT, type SlicerText } from './model';

/**
 * The slicer of the folder on screen: the last scan's, or (desktop, before a scan) the slicer
 * whose default folder is shown. Bambu Studio when nothing tells.
 */
export const SlicerContext = createContext<SlicerText>(SLICER_TEXT.bambu);

export function useSlicer(): SlicerText {
  return useContext(SlicerContext);
}
