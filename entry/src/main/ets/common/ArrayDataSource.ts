// file: .ts — no UI here; IDataSource/DataChangeListener are ambient, not .ets-only
export class ArrayDataSource<T> implements IDataSource {
  private data: T[];
  private listeners: DataChangeListener[] = [];
  constructor(data: T[]) { this.data = data; }
  totalCount(): number { return this.data.length; }
  getData(index: number): T { return this.data[index]; }
  registerDataChangeListener(l: DataChangeListener): void { this.listeners.push(l); }
  unregisterDataChangeListener(l: DataChangeListener): void {
    const i = this.listeners.indexOf(l);
    if (i >= 0) { this.listeners.splice(i, 1); }
  }
  reload(data: T[]): void {
    this.data = data;
    this.listeners.forEach((l: DataChangeListener) => l.onDataReloaded());
  }
}
