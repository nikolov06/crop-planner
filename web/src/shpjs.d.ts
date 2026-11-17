declare module 'shpjs' {
  type FC = GeoJSON.FeatureCollection & { fileName?: string }
  // Парсва .zip със SHP (+ .dbf, .prj) в GeoJSON; при наличен .prj превежда координатите в WGS84.
  export default function shp(input: ArrayBuffer | string): Promise<FC | FC[]>
}
