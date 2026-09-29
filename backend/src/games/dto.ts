import { Type, Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, Max } from 'class-validator';

export class ListGamesQuery {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsIn(['custom', 'name', 'created', 'duration', 'mediaCount', 'metacritic'])
  sort?: 'custom' | 'name' | 'created' | 'duration' | 'mediaCount' | 'metacritic';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  yearMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  minScore?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  maxScore?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class UpdateGameDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  /** Feature 6: user-selected play platforms (multi-select). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  platforms?: string[];

  /** Feature 5: gallery card display mode. */
  @IsOptional()
  @IsIn(['static', 'slideshow'])
  posterMode?: 'static' | 'slideshow';
}

export class RefreshGameDto {
  @IsOptional()
  @IsIn(['rawg', 'igdb', 'hltb', 'steam', 'metacritic'], { each: true })
  providers?: string[];
}