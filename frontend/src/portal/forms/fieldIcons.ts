import {
  AlignLeft,
  CalendarDays,
  CircleDot,
  Heading,
  ListChecks,
  Pilcrow,
  ToggleLeft,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { FieldType } from '../../api/forms';

export const FIELD_ICONS: Record<FieldType, LucideIcon> = {
  heading: Heading,
  paragraph: Pilcrow,
  short_text: Type,
  long_text: AlignLeft,
  date: CalendarDays,
  single_choice: CircleDot,
  multi_choice: ListChecks,
  yes_no: ToggleLeft,
};
