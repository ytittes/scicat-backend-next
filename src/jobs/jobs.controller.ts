import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  UseInterceptors,
  HttpStatus,
  HttpException,
} from "@nestjs/common";
import { FilterQuery } from "mongoose";
import { JobsService } from "./jobs.service";
import { CreateJobDto } from "./dto/create-job.dto";
import { UpdateJobDto } from "./dto/update-job.dto";
import { PoliciesGuard } from "src/casl/guards/policies.guard";
import { CheckPolicies } from "src/casl/decorators/check-policies.decorator";
import { AppAbility } from "src/casl/casl-ability.factory";
import { Action } from "src/casl/action.enum";
import { Job, JobDocument } from "./schemas/job.schema";
import { ApiBearerAuth, ApiQuery, ApiTags } from "@nestjs/swagger";
import { IFacets, IFilters } from "src/common/interfaces/common.interface";
import { SetCreatedUpdatedAtInterceptor } from "src/common/interceptors/set-created-updated-at.interceptor";
import { DatasetsService } from "src/datasets/datasets.service";
import { JobType, DatasetState } from "./job-type.enum";

@ApiBearerAuth()
@ApiTags("jobs")
@Controller("jobs")
export class JobsController {
  constructor(
    private readonly jobsService: JobsService,
    private readonly datasetsService: DatasetsService,
  ) {}

  /**
   * Check that all dataset exists
   * @param {List of dataset id} ids
   */
  async checkDatasetsExistence(ids: string[]) {
    if (ids.length === 0) {
      throw new HttpException(
        {
          status: HttpStatus.BAD_REQUEST,
          message: "Empty list of datasets - no Job sent",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const filter = {
      fields: {
        pid: true,
      },
      where: {
        pid: {
          $in: ids,
        },
      },
    };

    const datasets = await this.datasetsService.findAll(filter);

    if (datasets.length != ids.length) {
      throw new HttpException(
        {
          status: HttpStatus.BAD_REQUEST,
          message:
            "At least one of the datasets could not be found - no Job sent",
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  /**
   * Check that datasets is in state which the job can be performed
   * For retrieve jobs all datasets must be in state retrievable
   * For archive jobs all datasets must be in state archivable
   *      * For copy jobs no need to check only need to filter out datasets that have already been copied when submitting to job queue
   * ownerGroup is tested implicitly via Ownable
   */
  async checkDatasetsState(type: string, ids: string[]) {
    switch (type) {
      case JobType.Retrieve: //Intentional fall through
      case JobType.Archive:
        {
          const filter = {
            fields: {
              pid: true,
            },
            where: {
              [`datasetlifecycle.${DatasetState[type]}`]: false,
              pid: {
                $in: ids,
              },
            },
          };
          const result = await this.datasetsService.findAll(filter);
          if (result.length > 0) {
            throw new HttpException(
              {
                status: HttpStatus.CONFLICT,
                message: `The following datasets are not in ${DatasetState[type]} state - no ${type} job sent:\n`,
                error: JSON.stringify(result),
              },
              HttpStatus.CONFLICT,
            );
          }
        }
        break;
      case JobType.Public:
        {
          const filter = {
            fields: {
              pid: true,
            },
            where: {
              [DatasetState.public]: true,
              pid: {
                $in: ids,
              },
            },
          };
          const result = await this.datasetsService.findAll(filter);
          if (result.length !== ids.length) {
            throw new HttpException(
              {
                status: HttpStatus.CONFLICT,
                message: "The following datasets are not public - no job sent",
                error: JSON.stringify(result),
              },
              HttpStatus.CONFLICT,
            );
          }
        }
        break;
      default:
        //Not check other job types
        break;
    }
  }

  async checkFilesExistence(crateJobDto: CreateJobDto) {
    const datasetsToCheck = crateJobDto.datasetList.filter(
      (x) => x.files.length > 0,
    );
    const ids = datasetsToCheck.map((x) => x.pid);
    switch (crateJobDto.type) {
      case JobType.Public:
        if (ids.length > 0) {
          const filter = {
            fields: {
              pid: true,
              datasetId: true,
              dataFileList: true,
            },
            where: {
              pid: {
                $in: ids,
              },
            },
            include: [{ relation: "origdatablocks" }],
          };
          // Indexing originDataBlock with pid and create set of files for each dataset
          const datasets = await this.datasetsService.findAll(filter);
          const result: Record<string, Set<string>> = datasets.reduce(
            (acc: Record<string, Set<string>>, dataset) => {
              // Using Set make searching more efficient
              const files = dataset.origdatablocks.reduce((acc, block) => {
                block.dataFileList.forEach((file) => {
                  acc.add(file.path);
                });
                return acc;
              }, new Set<string>());
              acc[dataset.pid] = files;
              return acc;
            },
            {},
          );
          // Get a list of requested files that is not in originDataBlocks
          const checkResults = datasetsToCheck.reduce(
            (acc: { pid: string; nonExistFiles: string[] }[], x) => {
              const pid = x.pid;
              const referenceFiles = result[pid];
              const nonExistFiles = x.files.filter(
                (f) => !referenceFiles.has(f),
              );
              if (nonExistFiles.length > 0) {
                acc.push({ pid, nonExistFiles });
              }
              return acc;
            },
            [],
          );

          if (checkResults.length > 0) {
            throw new HttpException(
              {
                status: HttpStatus.BAD_REQUEST,
                message:
                  "At least one requested file could not be found - no job created",
              },
              HttpStatus.BAD_REQUEST,
            );
          }
        }
        break;
      default:
        // Not check for other job
        break;
    }
  }

  /**
   * Validate if the job is performable
   */
  async validateJob(createJobDto: CreateJobDto) {
    const ids = createJobDto.datasetList.map((x) => x.pid);
    // checkPermission(ctx, ids);
    await this.checkDatasetsExistence(ids);
    await this.checkDatasetsState(createJobDto.type, ids);
    await this.checkFilesExistence(createJobDto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Create, Job))
  @UseInterceptors(new SetCreatedUpdatedAtInterceptor<Job>("creationTime"))
  @Post()
  async create(@Body() createJobDto: CreateJobDto): Promise<Job> {
    await this.validateJob(createJobDto);

    return this.jobsService.create(createJobDto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Job))
  @Get()
  @ApiQuery({
    name: "filter",
    description: "Database filters to apply when retrieve all jobs",
    required: false,
  })
  async findAll(@Query("filter") filter?: string): Promise<Job[]> {
    const parsedFilter: IFilters<
      JobDocument,
      FilterQuery<JobDocument>
    > = JSON.parse(filter ?? "{}");
    return this.jobsService.findAll(parsedFilter);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Job))
  @Get("/fullquery")
  async fullquery(
    @Query() filters: { fields?: string; limits?: string },
  ): Promise<Job[]> {
    const parsedFilters: IFilters<JobDocument, FilterQuery<JobDocument>> = {
      fields: JSON.parse(filters.fields ?? "{}"),
      limits: JSON.parse(filters.limits ?? "{}"),
    };
    return this.jobsService.fullquery(parsedFilters);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Job))
  @Get("/fullfacet")
  async fullfacet(
    @Query() filters: { fields?: string; facets?: string },
  ): Promise<Record<string, unknown>[]> {
    const parsedFilters: IFacets<FilterQuery<JobDocument>> = {
      fields: JSON.parse(filters.fields ?? "{}"),
      facets: JSON.parse(filters.facets ?? "[]"),
    };
    return this.jobsService.fullfacet(parsedFilters);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Read, Job))
  @Get(":id")
  async findOne(@Param("id") id: string): Promise<Job | null> {
    return this.jobsService.findOne({ _id: id });
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Update, Job))
  @Patch(":id")
  async update(
    @Param("id") id: string,
    @Body() updateJobDto: UpdateJobDto,
  ): Promise<Job | null> {
    return this.jobsService.update({ _id: id }, updateJobDto);
  }

  @UseGuards(PoliciesGuard)
  @CheckPolicies((ability: AppAbility) => ability.can(Action.Delete, Job))
  @Delete(":id")
  async remove(@Param("id") id: string): Promise<unknown> {
    return this.jobsService.remove({ _id: id });
  }
}
