// The patients behind one count on "Conversion by cohort". The same page
// component as the Not booked lists (NotBookedList.tsx), with the conversion
// source: same columns plus "Converted on", same pagination and CSV export.

import { CONVERSION_SOURCE, PatientListPage } from "./NotBookedList";

export default function ConversionList() {
  return <PatientListPage source={CONVERSION_SOURCE} />;
}
