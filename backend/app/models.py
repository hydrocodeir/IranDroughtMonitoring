from sqlalchemy import Column, Integer, String, Date, Float, ForeignKey, Index
from sqlalchemy.orm import relationship
from geoalchemy2 import Geometry

from .database import Base


class Region(Base):
    __tablename__ = "regions"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    level = Column(String, nullable=False, index=True)
    geom = Column(Geometry("MULTIPOLYGON", srid=4326), nullable=False)

    time_series = relationship("TimeSeries", back_populates="region", cascade="all, delete-orphan")

    __table_args__ = (
        Index("idx_regions_geom", "geom", postgresql_using="gist"),
    )


class TimeSeries(Base):
    __tablename__ = "time_series"

    id = Column(Integer, primary_key=True)
    region_id = Column(Integer, ForeignKey("regions.id"), nullable=False)
    date = Column(Date, nullable=False)
    spi3 = Column(Float, nullable=False)
    spei3 = Column(Float, nullable=False)
    precip = Column(Float, nullable=False)
    temp = Column(Float, nullable=False)

    region = relationship("Region", back_populates="time_series")

    __table_args__ = (
        Index("idx_time_series_region_date", "region_id", "date"),
    )
