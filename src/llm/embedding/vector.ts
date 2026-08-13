/** 向量统一在运行时边界完成有限数值校验和 L2 归一化。 */
export function normalizeEmbedding(values: ArrayLike<number>): Float32Array {
  if (values.length === 0) throw new Error("Embedding vector cannot be empty.");
  let squaredNorm = 0;
  const vector = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error("Embedding vector contains a non-finite value.");
    }
    vector[index] = value;
    squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new Error("Embedding vector must have a positive finite norm.");
  }
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY;
  let similarity = 0;
  for (let index = 0; index < left.length; index += 1) similarity += left[index]! * right[index]!;
  return Number.isFinite(similarity) ? Math.max(-1, Math.min(1, similarity)) : Number.NEGATIVE_INFINITY;
}
