// The patients behind one count on "Conversion by cohort". The same page
// component as the day-14 lists (UnscheduledList.tsx), with the conversion
// source: same columns plus "Converted on", same pagination and CSV export.

import { CONVERSION_SOURCE, PatientListPage } from "./UnscheduledList";

export default function ConversionList() {
  return <PatientListPage source={CONVERSION_SOURCE} />;
}
