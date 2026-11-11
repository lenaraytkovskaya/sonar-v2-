import { compareModelPrice, type TextModel } from '@sonar/core';

export function filterModels(
  models: TextModel[],
  query: string,
  onlyCheap: boolean,
  selectedId: string,
) {
  const search = query.trim().toLowerCase();
  return models
    .filter(
      (model) =>
        model.id === selectedId ||
        ((!onlyCheap || model.completionUsd <= 1e-6) &&
          (model.id.toLowerCase().includes(search) ||
            model.name.toLowerCase().includes(search))),
    )
    .sort(
      (a, b) =>
        Number(b.id.toLowerCase().startsWith(search)) -
          Number(a.id.toLowerCase().startsWith(search)) ||
        compareModelPrice(a, b),
    );
}
