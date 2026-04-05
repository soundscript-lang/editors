import type { EditorProjectSnapshot } from './editor_process_support';

type ProjectionSnapshotLike = Pick<
  EditorProjectSnapshot,
  'originalText' | 'postRewriteStage' | 'projectedText' | 'rewriteStage'
>;

interface SerializedLineMapping {
  originalEnd: number;
  originalStart: number;
  rewrittenEnd: number;
  rewrittenStart: number;
}

interface SerializedReplacement {
  mappedSegments?: ReadonlyArray<{
    originalEnd: number;
    originalStart: number;
    rewrittenEnd: number;
    rewrittenStart: number;
  }>;
  originalSpan: {
    end: number;
    start: number;
  };
  rewrittenSpan: {
    end: number;
    start: number;
  };
}

interface SerializedStage {
  lineMappings?: readonly SerializedLineMapping[];
  replacements: readonly SerializedReplacement[];
  rewrittenText: string;
}

interface PreparedProjection {
  originalText: string;
  postRewriteStage?: SerializedStage;
  rewriteResult: SerializedStage;
  rewrittenText: string;
}

export interface MappedProjectedPosition {
  insideReplacement: boolean;
  position: number;
}

export interface MappedSourceRange {
  end: number;
  intersectsReplacement: boolean;
  start: number;
}

function toPreparedProjection(snapshot: ProjectionSnapshotLike): PreparedProjection {
  return {
    originalText: snapshot.originalText,
    postRewriteStage: snapshot.postRewriteStage as SerializedStage | undefined,
    rewriteResult: snapshot.rewriteStage as SerializedStage,
    rewrittenText: snapshot.projectedText,
  };
}

function findAlignedLineMapping(
  lineMappings: readonly SerializedLineMapping[] | undefined,
  position: number,
  direction: 'original' | 'rewritten',
): SerializedLineMapping | undefined {
  if (!lineMappings) {
    return undefined;
  }

  for (const mapping of lineMappings) {
    const start = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    const end = direction === 'original' ? mapping.originalEnd : mapping.rewrittenEnd;
    if (position >= start && position <= end) {
      return mapping;
    }
  }

  return undefined;
}

function hasSufficientAlignedLineContext(
  stage: Pick<SerializedStage, 'lineMappings' | 'replacements'>,
  targetMapping: SerializedLineMapping,
  direction: 'original' | 'rewritten',
): boolean {
  const lineMappings = stage.lineMappings;
  if (!lineMappings || lineMappings.length === 0) {
    return false;
  }

  const targetIndex = lineMappings.indexOf(targetMapping);
  if (targetIndex === -1) {
    return false;
  }

  const previousReplacementBoundaries = [...stage.replacements]
    .filter((replacement) => {
      const start = direction === 'original'
        ? replacement.originalSpan.start
        : replacement.rewrittenSpan.start;
      const end = direction === 'original'
        ? replacement.originalSpan.end
        : replacement.rewrittenSpan.end;
      return end > start;
    })
    .map((replacement) =>
      direction === 'original' ? replacement.originalSpan.end : replacement.rewrittenSpan.end
    )
    .filter((end) =>
      end <= (direction === 'original' ? targetMapping.originalStart : targetMapping.rewrittenStart)
    );
  const previousReplacementBoundary = previousReplacementBoundaries.length > 0
    ? previousReplacementBoundaries[previousReplacementBoundaries.length - 1]
    : undefined;

  if (previousReplacementBoundary === undefined) {
    return true;
  }

  let alignedLinesSincePreviousRewrite = 0;
  for (let index = targetIndex; index >= 0; index -= 1) {
    const mapping = lineMappings[index]!;
    const mappingStart = direction === 'original' ? mapping.originalStart : mapping.rewrittenStart;
    if (mappingStart < previousReplacementBoundary) {
      break;
    }
    alignedLinesSincePreviousRewrite += 1;
  }

  return alignedLinesSincePreviousRewrite >= 1;
}

function mapSourcePositionThroughReplacementSegments(
  replacement: SerializedReplacement,
  sourcePosition: number,
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    if (sourcePosition < segment.originalStart || sourcePosition >= segment.originalEnd) {
      continue;
    }

    return Math.min(
      segment.rewrittenEnd,
      segment.rewrittenStart + (sourcePosition - segment.originalStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementSegments(
  replacement: SerializedReplacement,
  programPosition: number,
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    if (programPosition < segment.rewrittenStart || programPosition >= segment.rewrittenEnd) {
      continue;
    }

    return Math.min(
      segment.originalEnd,
      segment.originalStart + (programPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramPositionThroughReplacementBoundarySegments(
  replacement: SerializedReplacement,
  programPosition: number,
  affinity: 'start' | 'end',
): number | undefined {
  for (const segment of replacement.mappedSegments ?? []) {
    const isInside = programPosition >= segment.rewrittenStart &&
      programPosition < segment.rewrittenEnd;
    const isExactEnd = affinity === 'end' && programPosition === segment.rewrittenEnd;
    if (!isInside && !isExactEnd) {
      continue;
    }

    const clampedProgramPosition = Math.min(programPosition, segment.rewrittenEnd);
    return Math.min(
      segment.originalEnd,
      segment.originalStart + (clampedProgramPosition - segment.rewrittenStart),
    );
  }

  return undefined;
}

function mapProgramRangeThroughReplacementSegments(
  intersectingReplacements: readonly SerializedReplacement[],
  programStart: number,
  programEnd: number,
): MappedSourceRange | null {
  if (intersectingReplacements.length !== 1) {
    return null;
  }

  const [replacement] = intersectingReplacements;
  if (!replacement) {
    return null;
  }

  const mappedSegment = (replacement.mappedSegments ?? []).find((segment) =>
    programStart >= segment.rewrittenStart &&
    programEnd <= segment.rewrittenEnd
  );
  if (!mappedSegment) {
    return null;
  }

  const start = mappedSegment.originalStart + (programStart - mappedSegment.rewrittenStart);
  const end = mappedSegment.originalStart + (programEnd - mappedSegment.rewrittenStart);
  return {
    intersectsReplacement: false,
    start,
    end: Math.max(start, end),
  };
}

function mapSourcePositionToAlignedStageLine(
  stage: Pick<SerializedStage, 'lineMappings' | 'replacements'>,
  position: number,
): number | undefined {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'original');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.originalEnd <= replacement.originalSpan.start ||
      mapping.originalStart >= replacement.originalSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'original')) {
    return undefined;
  }

  return Math.min(
    mapping.rewrittenEnd,
    mapping.rewrittenStart + (position - mapping.originalStart),
  );
}

function mapProgramPositionToAlignedStageLine(
  stage: Pick<SerializedStage, 'lineMappings' | 'replacements'>,
  position: number,
): number | undefined {
  const mapping = findAlignedLineMapping(stage.lineMappings, position, 'rewritten');
  if (!mapping) {
    return undefined;
  }

  const intersectsReplacement = stage.replacements.some((replacement) =>
    !(mapping.rewrittenEnd <= replacement.rewrittenSpan.start ||
      mapping.rewrittenStart >= replacement.rewrittenSpan.end)
  );
  if (intersectsReplacement) {
    return undefined;
  }

  if (!hasSufficientAlignedLineContext(stage, mapping, 'rewritten')) {
    return undefined;
  }

  return Math.min(
    mapping.originalEnd,
    mapping.originalStart + (position - mapping.rewrittenStart),
  );
}

function mapSourcePositionToStage(
  stage: SerializedStage,
  sourcePosition: number,
): MappedProjectedPosition {
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      break;
    }
    if (sourcePosition < replacement.originalSpan.end) {
      const mappedSegmentPosition = mapSourcePositionThroughReplacementSegments(
        replacement,
        sourcePosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.rewrittenSpan.start,
      };
    }
  }

  const mappedPosition = mapSourcePositionToAlignedStageLine(stage, sourcePosition);
  if (mappedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: mappedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (sourcePosition < replacement.originalSpan.start) {
      return {
        insideReplacement: false,
        position: sourcePosition + delta,
      };
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.min(sourcePosition + delta, stage.rewrittenText.length),
  };
}

function mapProgramPositionToStageSource(
  stage: SerializedStage,
  programPosition: number,
): MappedProjectedPosition {
  const clampedPosition = Math.min(programPosition, stage.rewrittenText.length);
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementSegments(
        replacement,
        clampedPosition,
      );
      if (mappedSegmentPosition !== undefined) {
        return {
          insideReplacement: false,
          position: mappedSegmentPosition,
        };
      }
      return {
        insideReplacement: true,
        position: replacement.originalSpan.start,
      };
    }
  }

  const mappedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (mappedPosition !== undefined) {
    return {
      insideReplacement: false,
      position: mappedPosition,
    };
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return {
        insideReplacement: false,
        position: clampedPosition - delta,
      };
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return {
    insideReplacement: false,
    position: Math.max(0, clampedPosition - delta),
  };
}

function mapProgramPositionToStageSourceBoundary(
  stage: SerializedStage,
  programPosition: number,
  affinity: 'start' | 'end',
): number {
  const clampedPosition = Math.min(programPosition, stage.rewrittenText.length);
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      break;
    }
    if (clampedPosition < replacement.rewrittenSpan.end) {
      const mappedSegmentPosition = mapProgramPositionThroughReplacementBoundarySegments(
        replacement,
        clampedPosition,
        affinity,
      );
      if (mappedSegmentPosition !== undefined) {
        return mappedSegmentPosition;
      }
      return affinity === 'start' ? replacement.originalSpan.start : replacement.originalSpan.end;
    }
  }

  const mappedPosition = mapProgramPositionToAlignedStageLine(stage, clampedPosition);
  if (mappedPosition !== undefined) {
    return mappedPosition;
  }

  let delta = 0;
  for (const replacement of stage.replacements) {
    if (clampedPosition < replacement.rewrittenSpan.start) {
      return Math.max(0, clampedPosition - delta);
    }

    delta += (replacement.rewrittenSpan.end - replacement.rewrittenSpan.start) -
      (replacement.originalSpan.end - replacement.originalSpan.start);
  }

  return Math.max(0, clampedPosition - delta);
}

function mapProgramRangeToStageSource(
  stage: SerializedStage,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const clampedStart = Math.min(programStart, stage.rewrittenText.length);
  const clampedEnd = Math.min(programEnd, stage.rewrittenText.length);
  const intersectingReplacements = stage.replacements.filter((replacement) =>
    !(clampedEnd <= replacement.rewrittenSpan.start ||
      clampedStart >= replacement.rewrittenSpan.end)
  );

  if (intersectingReplacements.length > 0) {
    const preciselyMappedRange = mapProgramRangeThroughReplacementSegments(
      intersectingReplacements,
      clampedStart,
      clampedEnd,
    );
    if (preciselyMappedRange) {
      return preciselyMappedRange;
    }
    return {
      intersectsReplacement: true,
      start: intersectingReplacements[0]!.originalSpan.start,
      end: intersectingReplacements[intersectingReplacements.length - 1]!.originalSpan.end,
    };
  }

  const mappedStart = mapProgramPositionToStageSource(stage, clampedStart).position;
  const mappedEnd = mapProgramPositionToStageSource(stage, clampedEnd).position;
  return {
    intersectsReplacement: false,
    start: mappedStart,
    end: Math.max(mappedStart, mappedEnd),
  };
}

export function mapSourcePositionToProjected(
  snapshot: ProjectionSnapshotLike,
  sourcePosition: number,
): MappedProjectedPosition {
  const preparedProjection = toPreparedProjection(snapshot);
  const stageOne = mapSourcePositionToStage(preparedProjection.rewriteResult, sourcePosition);
  if (!preparedProjection.postRewriteStage) {
    return stageOne;
  }

  const stageTwo = mapSourcePositionToStage(
    preparedProjection.postRewriteStage,
    stageOne.position,
  );
  return {
    insideReplacement: stageOne.insideReplacement || stageTwo.insideReplacement,
    position: stageTwo.position,
  };
}

export function mapProjectedEnclosingRangeToSource(
  snapshot: ProjectionSnapshotLike,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const preparedProjection = toPreparedProjection(snapshot);
  const finalTextLength = preparedProjection.rewrittenText.length;
  const clampedStart = Math.min(programStart, finalTextLength);
  const clampedEnd = Math.min(programEnd, finalTextLength);
  const stageTwoMapped = preparedProjection.postRewriteStage
    ? mapProgramRangeToStageSource(
      preparedProjection.postRewriteStage,
      clampedStart,
      clampedEnd,
    )
    : {
      intersectsReplacement: false,
      start: clampedStart,
      end: clampedEnd,
    };
  const stageTwoStart = preparedProjection.postRewriteStage
    ? mapProgramPositionToStageSourceBoundary(
      preparedProjection.postRewriteStage,
      clampedStart,
      'start',
    )
    : clampedStart;
  const stageTwoEnd = preparedProjection.postRewriteStage
    ? mapProgramPositionToStageSourceBoundary(
      preparedProjection.postRewriteStage,
      clampedEnd,
      'end',
    )
    : clampedEnd;
  const stageOneStart = mapProgramPositionToStageSourceBoundary(
    preparedProjection.rewriteResult,
    stageTwoStart,
    'start',
  );
  const stageOneEnd = mapProgramPositionToStageSourceBoundary(
    preparedProjection.rewriteResult,
    stageTwoEnd,
    'end',
  );

  return {
    intersectsReplacement: stageTwoMapped.intersectsReplacement,
    start: Math.min(preparedProjection.originalText.length, stageOneStart),
    end: Math.min(preparedProjection.originalText.length, Math.max(stageOneStart, stageOneEnd)),
  };
}

export function mapProjectedRangeToSource(
  snapshot: ProjectionSnapshotLike,
  programStart: number,
  programEnd: number,
): MappedSourceRange {
  const preparedProjection = toPreparedProjection(snapshot);
  const finalTextLength = preparedProjection.rewrittenText.length;
  const clampedStart = Math.min(programStart, finalTextLength);
  const clampedEnd = Math.min(programEnd, finalTextLength);
  const stageTwoRange = preparedProjection.postRewriteStage
    ? mapProgramRangeToStageSource(
      preparedProjection.postRewriteStage,
      clampedStart,
      clampedEnd,
    )
    : {
      intersectsReplacement: false,
      start: clampedStart,
      end: clampedEnd,
    };
  const stageOneRange = mapProgramRangeToStageSource(
    preparedProjection.rewriteResult,
    stageTwoRange.start,
    stageTwoRange.end,
  );

  return {
    intersectsReplacement: stageTwoRange.intersectsReplacement || stageOneRange.intersectsReplacement,
    start: Math.min(preparedProjection.originalText.length, stageOneRange.start),
    end: Math.min(
      preparedProjection.originalText.length,
      Math.max(stageOneRange.start, stageOneRange.end),
    ),
  };
}
